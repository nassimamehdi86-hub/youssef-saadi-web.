/* =========================================================================================
   telegram-webhook-worker.js — القبول التلقائي للتلاميذ عبر تيليجرام
   ---------------------------------------------------------------------------------------
   الفكرة: التلميذ يفتح محادثة خاصة مع البوت ويضغط زر "مشاركة رقم هاتفي" (Telegram يتكفّل
   بإثبات أن الرقم فعلاً ملك صاحب الحساب — لا يمكن لأحد إرسال رقم غيره). هذا الـ Worker
   يستقبل تلك المشاركة من تيليجرام، ويسجّل الرقم في Firestore ضمن مجموعة
   "telegramVerifiedPhones". عند تسجيل التلميذ في المنصة برقم مطابق، يقبله app.js تلقائيًا
   دون انتظار موافقة الأستاذ (راجع دالة Student.register في app.js).

   دليل النشر الكامل خطوة بخطوة: TELEGRAM_AUTO_APPROVAL_GUIDE.md
   ========================================================================================= */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK — هذا الرابط مخصّص لتيليجرام فقط (webhook).', { status: 200 });
    }

    /* تحقّق أن الطلب قادم فعلاً من تيليجرام عبر الرمز السرّي الذي تضعه أنت عند ربط الـ webhook
       (secret_token) — يمنع أي شخص آخر يكتشف رابط الـ Worker من تزوير طلبات وهمية */
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.WEBHOOK_SECRET || secretHeader !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.FIREBASE_PROJECT_ID) {
      console.error('WEBHOOK_SECRET أو TELEGRAM_BOT_TOKEN أو FIREBASE_PROJECT_ID غير مضبوطة في الـ Worker');
      return new Response('OK', { status: 200 }); /* نرد 200 لتيليجرام دائمًا حتى لا يعيد المحاولة بلا فائدة */
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response('OK', { status: 200 });
    }

    try {
      await handleUpdate(update, env);
    } catch (e) {
      console.error('خطأ أثناء معالجة تحديث تيليجرام:', e);
    }

    /* نرد 200 دائمًا لتيليجرام (حتى لو حدث خطأ داخلي) لمنعه من إعادة إرسال نفس التحديث بلا توقف */
    return new Response('OK', { status: 200 });
  }
};

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat && message.chat.id;
  if (!chatId) return;

  /* أمر البداية: نرسل للتلميذ زر "مشاركة رقم هاتفي" — Telegram يمنع مشاركة رقم غير رقمه هو
     عبر هذا الزر تحديدًا، وهذا ما يجعل الطريقة موثوقة */
  if (message.text === '/start') {
    await sendMessage(env, chatId,
      'مرحبًا بك 👋\n\nلتفعيل قبولك التلقائي في المنصة، اضغط الزر أدناه لمشاركة رقم هاتفك (بشكل آمن — عبر تيليجرام مباشرة).\n\nبعدها عُد إلى المنصة وسجّل حسابك بنفس رقم الهاتف، وستُقبل مباشرة دون انتظار.',
      {
        keyboard: [[{ text: '📱 مشاركة رقم هاتفي', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    );
    return;
  }

  /* مشاركة جهة اتصال */
  const contact = message.contact;
  if (!contact) {
    await sendMessage(env, chatId, 'أرسل /start للبدء، ثم اضغط زر مشاركة رقم الهاتف. ⬇️');
    return;
  }

  /* أمان: تأكد أن التلميذ شارك رقمه هو شخصيًا، وليس رقم شخص آخر أرسله كجهة اتصال عادية */
  const sharerId = message.from && message.from.id;
  if (!contact.user_id || contact.user_id !== sharerId) {
    await sendMessage(env, chatId, '⚠️ يجب مشاركة رقمك الشخصي فقط (عبر زر "مشاركة رقم هاتفي")، وليس رقم شخص آخر.');
    return;
  }

  const canonical = canonicalPhone(contact.phone_number);
  if (!canonical) {
    await sendMessage(env, chatId, '⚠️ تعذّر قراءة الرقم، حاول مجددًا.');
    return;
  }

  const ok = await saveVerifiedPhone(env, canonical, {
    telegramUserId: String(sharerId),
    telegramUsername: message.from.username || null,
    telegramFirstName: contact.first_name || message.from.first_name || null,
    telegramLastName: contact.last_name || null
  });

  if (ok) {
    await sendMessage(env, chatId,
      '✅ تم استلام رقم هاتفك بنجاح.\n\nعُد الآن إلى منصة الأستاذ وسجّل حسابك بنفس رقم الهاتف — سيُقبل طلبك مباشرة. 🎓');
  } else {
    await sendMessage(env, chatId, '❌ حدث خطأ أثناء الحفظ، حاول مجددًا بعد قليل.');
  }
}

/* آخر 9 أرقام فقط — لتوحيد الصيغة المحلية (0555xxxxxx) والدولية (+213555xxxxxx) في مفتاح واحد،
   بما يطابق تمامًا Student.canonicalPhone في app.js */
function canonicalPhone(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

async function sendMessage(env, chatId, text, replyKeyboard) {
  const body = { chat_id: chatId, text };
  if (replyKeyboard) body.reply_markup = replyKeyboard;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('تعذّر إرسال رسالة تيليجرام:', e);
  }
}

/* كتابة الرقم الموثّق في Firestore عبر REST API مباشرة (بدون مفاتيح سرّية — يعتمد على
   قواعد أمان Firestore الموضّحة في دليل النشر لتقييد من يمكنه الكتابة في هذه المجموعة تحديدًا) */
async function saveVerifiedPhone(env, canonicalPhoneKey, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/telegramVerifiedPhones/${canonicalPhoneKey}`;
  const fields = {
    telegramUserId:   { stringValue: data.telegramUserId || '' },
    telegramUsername: data.telegramUsername ? { stringValue: data.telegramUsername } : { nullValue: null },
    telegramFirstName:{ stringValue: data.telegramFirstName || '' },
    telegramLastName: { stringValue: data.telegramLastName || '' },
    verifiedAt:        { timestampValue: new Date().toISOString() }
  };
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return res.ok;
  } catch (e) {
    console.error('تعذّر الكتابة في Firestore:', e);
    return false;
  }
}

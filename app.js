/* =========================================================================================
   منصة الأستاذ يوسف سعدي — المنطق الرئيسي (Firebase + التسجيل + القفل + الاختبارات)
   ========================================================================================= */

/* ---------- تهيئة Firebase (compat SDK، محمّل من CDN في index.html) ---------- */
let fbApp = null, db = null, fbReady = false;
try{
  if(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.apiKey.indexOf('ضع_') === -1){
    fbApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    db = firebase.firestore();
    fbReady = true;
  }
}catch(e){ console.warn('Firebase init failed', e); }

/* ---------- مشروع Firebase ثانٍ منفصل (اختياري) للدردشة والإشعارات فقط ----------
   الهدف: عزل قراءات هذين القسمين (اللذين يعملان عند كل تلميذ فور فتح الصفحة) عن باقي
   المنصة (التسجيل، التمارين، المعدّلات) في مشروع Firebase مختلف بسقف يومي مستقل خاص به،
   حتى لا يوقف أي منهما بقية المنصة عند استهلاك سقف القراءات المجاني.
   إن لم تُضبط مفاتيح window.FIREBASE_CONFIG_SECONDARY بعد (في firebase-config.js)،
   يرجع النظام تلقائيًا لاستعمال نفس قاعدة البيانات الرئيسية حتى لا يتعطّل شيء. */
let fbApp2 = null, db2 = null, fbReady2 = false;
try{
  if(window.FIREBASE_CONFIG_SECONDARY && window.FIREBASE_CONFIG_SECONDARY.apiKey && window.FIREBASE_CONFIG_SECONDARY.apiKey.indexOf('ضع_') === -1){
    fbApp2 = firebase.initializeApp(window.FIREBASE_CONFIG_SECONDARY, 'secondary');
    db2 = fbApp2.firestore();
    fbReady2 = true;
  }
}catch(e){ console.warn('Firebase (secondary) init failed', e); }

/* قاعدة البيانات الفعلية المستعملة للدردشة والإشعارات: المشروع الثاني إن كان مضبوطًا،
   وإلا نرجع مؤقتًا لنفس قاعدة البيانات الرئيسية (fallback آمن قبل إعداد المشروع الثاني). */
function auxDb(){ return fbReady2 ? db2 : db; }
function auxFbReady(){ return fbReady2 || fbReady; }

function fbUnavailableNotice(){
  return `<div class="note" style="margin:14px 0">
    <b>تنبيه:</b> لم يتم بعد ربط هذه النسخة بمشروع Firebase حقيقي. عدّل ملف
    <b>firebase-config.js</b> بمفاتيح مشروعك لتفعيل التسجيل والترتيب ولوحة التحكم.
    باقي المحتوى (الدروس، الفيديوهات، اختبار الفهم، إعراب الجمل) يعمل بلا اتصال بأي حال.
  </div>`;
}

/* =========================================================================================
   أدوات عامة: تطبيع نص عربي، توليد معرّف جلسة، تخزين محلي
   ========================================================================================= */
function normalizeAr(s){
  return (s||'')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g,'')
    .replace(/[إأآٱا]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/ؤ/g,'و').replace(/ئ/g,'ي')
    .replace(/[^ابتثجحخدذرزسشصضطظعغفقكلمنهويءa-zA-ZàâäáãåæçéèêëíìîïñòóôöõøùúûüýÿœÀÂÄÁÃÅÆÇÉÈÊËÍÌÎÏÑÒÓÔÖÕØÙÚÛÜÝŸŒ0-9\s]/g,'').replace(/\s+/g,' ').trim();
}
function genSessionId(){ return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,10); }

/* ضغط صورة (وصل الدفع) في المتصفح إلى حجم صغير جدًا قبل إرسالها — تجنّبًا لاستخدام Firebase Storage */
function compressImageFile(file, maxDim){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        let { width, height } = img;
        const dim = maxDim || 700;
        if(width > height && width > dim){ height = Math.round(height * dim/width); width = dim; }
        else if(height > dim){ width = Math.round(width * dim/height); height = dim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.55));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function lsGet(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }

/* =========================================================================================
   حالة الطالب الحالية (Student State)
   ========================================================================================= */
const Student = {
  id:null, fullName:null, status:null, sessionId:null, unsubscribe:null, streak:0,
  lastQuestionAt:null, QUESTION_COOLDOWN_MS: 7*24*60*60*1000, /* سؤال واحد للأستاذ كل أسبوع */

  /* هل يحق للتلميذ طرح سؤال جديد للأستاذ الآن (لم يمرّ أسبوع كامل بعد آخر سؤال)؟ */
  canAskQuestion(){
    if(!this.lastQuestionAt) return true;
    const last = (typeof this.lastQuestionAt.toMillis === 'function') ? this.lastQuestionAt.toMillis() : this.lastQuestionAt;
    return (Date.now() - last) >= this.QUESTION_COOLDOWN_MS;
  },
  /* كم يومًا متبقيًا حتى يحق له طرح سؤال جديد */
  daysUntilNextQuestion(){
    if(!this.lastQuestionAt) return 0;
    const last = (typeof this.lastQuestionAt.toMillis === 'function') ? this.lastQuestionAt.toMillis() : this.lastQuestionAt;
    const remainMs = this.QUESTION_COOLDOWN_MS - (Date.now() - last);
    return Math.max(1, Math.ceil(remainMs / 86400000));
  },

  normalizedKey(fullName){ return normalizeAr(fullName); },

  /* تحديث سلسلة النشاط اليومية (أيام متتالية من الدخول) — تُستدعى بعد كل دخول ناجح */
  async updateStreak(){
    if(!fbReady || !this.id) return;
    const today = new Date().toISOString().slice(0,10);
    try{
      const ref = db.collection('students').doc(this.id);
      const snap = await ref.get();
      const data = snap.data() || {};
      const last = data.lastLoginDate;
      let streak = data.streak || 0;
      if(last !== today){
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
        streak = (last === yesterday) ? (streak + 1) : 1;
        await ref.update({ lastLoginDate: today, streak });
      }
      this.streak = streak;
    }catch(e){ this.streak = 0; }
  },

  /* تطبيع رقم الهاتف: نحتفظ فقط بالأرقام (نحذف المسافات والرموز) لضمان تطابق موحّد */
  normalizedPhone(phone){ return (phone||'').replace(/[^0-9]/g,''); },

  /* تطبيع "قانوني" لرقم الهاتف: آخر 9 أرقام فقط، ليتطابق الرقم بصيغته المحلية (0555xxxxxx)
     مع صيغته الدولية كما يرسلها تيليجرام (+213555xxxxxx) — يُستخدم حصرًا لمطابقة التحقق
     التلقائي عبر بوت تيليجرام، دون المساس بـ phoneKey الأصلي المستعمل لبقية النظام. */
  canonicalPhone(phone){
    const digits = (phone||'').replace(/[^0-9]/g,'');
    return digits.length >= 9 ? digits.slice(-9) : digits;
  },

  /* هل شارك صاحب هذا الرقم جهة اتصاله في محادثة خاصة مع بوت تيليجرام؟
     تُملأ مجموعة telegramVerifiedPhones تلقائيًا من طرف telegram-webhook-worker عند
     استقبال جهة اتصال موثّقة (راجع TELEGRAM_AUTO_APPROVAL_GUIDE.md). */
  async checkTelegramVerification(phone){
    if(!fbReady) return false;
    const canon = this.canonicalPhone(phone);
    if(!canon) return false;
    try{
      const snap = await db.collection('telegramVerifiedPhones').doc(canon).get();
      return snap.exists;
    }catch(e){ console.warn('تعذّر التحقق من تفعيل تيليجرام:', e); return false; }
  },

  /* بدء جلسة تلميذ مقبول مباشرة — نفس منطق نهاية login() الناجح، تُستخدم بعد القبول
     التلقائي عبر تيليجرام حتى يدخل التلميذ للمنصة فورًا دون الحاجة لإعادة تسجيل الدخول */
  async startApprovedSession(){
    if(!fbReady || !this.id) return;
    const newSession = genSessionId();
    await db.collection('students').doc(this.id).update({ currentSession:newSession, lastSeen:firebase.firestore.FieldValue.serverTimestamp() });
    this.sessionId = newSession;
    lsSet('student_session', newSession);
    this.watchSession();
    await this.updateStreak();
  },

  /* تسجيل الدخول بحساب موجود مسبقًا فقط — لا يُنشئ أي طلب جديد أبدًا.
     إن لم يوجد رقم الهاتف في القاعدة، تُعاد status:'not_found' لتظهر رسالة خطأ للتلميذ. */
  async login(fullName, phone){
    if(!fbReady) return { ok:false, reason:'no-firebase' };
    const phoneKey = this.normalizedPhone(phone);
    if(!phoneKey) return { ok:false, reason:'empty-phone' };

    const col = db.collection('students');
    const existing = await col.where('phoneKey','==', phoneKey).limit(1).get();

    if(existing.empty){
      return { ok:true, status:'not_found' };
    }

    const docSnap = existing.docs[0];
    const data = docSnap.data();
    this.id = docSnap.id; this.fullName = data.fullName; this.phone = data.phone; this.status = data.status;
    this.lastQuestionAt = data.lastQuestionAt || null;

    if(data.status === 'pending'){
      /* قيد الانتظار: قد يكون التلميذ سجّل في المنصة قبل تفعيل رقمه عبر بوت تيليجرام (أو نسي
         تفعيله وقتها) ثم فعّله لاحقًا — نعيد التحقق في كل محاولة دخول، فإن أصبح موثّقًا الآن
         نقبله فورًا بدل تركه عالقًا في "قيد الانتظار" لأجل غير مسمى */
      const telegramVerified = await this.checkTelegramVerification(data.phone);
      if(telegramVerified){
        await docSnap.ref.update({ status:'approved' });
        this.status = 'approved';
      } else {
        return { ok:true, status:'pending', fullName:this.fullName };
      }
    }
    if(data.status === 'rejected') return { ok:true, status:'rejected', fullName:this.fullName };

    /* موافق عليه: نبدأ جلسة جديدة (تطرد أي جلسة سابقة تلقائيًا) */
    const newSession = genSessionId();
    await col.doc(this.id).update({ currentSession:newSession, lastSeen:firebase.firestore.FieldValue.serverTimestamp() });
    this.sessionId = newSession;
    lsSet('student_id', this.id); lsSet('student_name', this.fullName); lsSet('student_session', newSession);
    lsSet('student_phone', this.phone);
    this.watchSession();
    await this.updateStreak();
    return { ok:true, status:'approved', fullName:this.fullName };
  },

  /* إنشاء حساب جديد فقط — إن كان رقم الهاتف مسجَّلًا من قبل بحالة "مقبول" أو "قيد الانتظار"،
     لا يُنشأ طلب مكرَّر، بل تُعاد status:'already_exists'.
     أما إن كان مرفوضًا سابقًا، فيُسمح للتلميذ بإعادة التسجيل: نُحدِّث نفس السجل ونعيده إلى "قيد الانتظار". */
  async register(fullName, phone, receiptDataUrl){
    if(!fbReady) return { ok:false, reason:'no-firebase' };
    const key = this.normalizedKey(fullName);
    const phoneKey = this.normalizedPhone(phone);
    if(!key) return { ok:false, reason:'empty-name' };
    if(!phoneKey) return { ok:false, reason:'empty-phone' };

    const col = db.collection('students');
    /* تحقق من وجود تسجيل سابق بنفس الرقم — إن فشلت هذه القراءة فقط (مثلاً بسبب استنفاد
       حصة القراءات المجانية في Firestore)، لا نمنع التسجيل: نتابع كأنه لا يوجد سجل سابق
       وننشئ حسابًا جديدًا مباشرة (عملية كتابة فقط، لا تتأثر بحصة القراءات). النتيجة النادرة
       المحتملة هي تسجيل مكرَّر لنفس الرقم خلال هذه الفترة فقط، يمكن دمجه لاحقًا يدويًا. */
    let existing = { empty:true, docs:[] };
    try{
      existing = await col.where('phoneKey','==', phoneKey).limit(1).get();
    }catch(e){
      console.warn('تعذّر التحقق من وجود تسجيل سابق (على الأرجح استُنفدت حصة القراءات) — سيُنشأ حساب جديد مباشرة:', e);
    }

    /* تحقق تلقائي: هل شارك هذا الرقم جهة اتصاله مع بوت تيليجرام مسبقًا؟
       إن كان كذلك، يُقبل التلميذ فورًا دون انتظار موافقة الأستاذ.
       (checkTelegramVerification محمية أصلًا بـ try/catch وتُعيد false عند أي فشل قراءة) */
    const telegramVerified = await this.checkTelegramVerification(phone);
    const initialStatus = telegramVerified ? 'approved' : 'pending';

    if(!existing.empty){
      const docSnap = existing.docs[0];
      const data = docSnap.data();

      if(data.status === 'pending'){
        /* قيد الانتظار: قد يكون فعّل رقمه في البوت الآن بعد أن سجّل — نقبله فورًا إن أصبح موثّقًا،
           بدل إبقائه عالقًا في "قيد الانتظار" لمجرد أن الترتيب كان معكوسًا */
        if(telegramVerified){
          await docSnap.ref.update({ status:'approved' });
          this.id = docSnap.id; this.fullName = data.fullName; this.phone = data.phone; this.status = 'approved';
          lsSet('student_id', this.id); lsSet('student_name', this.fullName); lsSet('student_phone', this.phone);
          await this.startApprovedSession();
          return { ok:true, status:'approved', fullName:this.fullName };
        }
        return { ok:true, status:'already_exists' };
      }

      if(data.status === 'approved'){
        /* مقبول مسبقًا: لا ننشئ حسابًا مكرَّرًا */
        return { ok:true, status:'already_exists' };
      }

      /* كان مرفوضًا سابقًا: نسمح له بإعادة إرسال طلب جديد على نفس السجل */
      await docSnap.ref.update({
        fullName: fullName.trim(), nameKey:key, status:initialStatus,
        receiptImage: receiptDataUrl || null,
        resubmittedAt: firebase.firestore.FieldValue.serverTimestamp(), currentSession:null
      });
      this.id = docSnap.id; this.fullName = fullName.trim(); this.phone = phone.trim(); this.status = initialStatus;
      lsSet('student_id', this.id); lsSet('student_name', this.fullName); lsSet('student_phone', this.phone);
      if(initialStatus === 'approved') await this.startApprovedSession();
      return { ok:true, status:initialStatus, fullName:this.fullName };
    }

    /* لا يوجد سجل سابق برقم الهاتف هذا: إنشاء حساب جديد — مقبول فورًا إن كان موثّقًا عبر
       تيليجرام، أو بحالة الانتظار كالمعتاد إن لم يكن كذلك */
    const newDoc = await col.add({
      fullName: fullName.trim(), nameKey:key, phone: phone.trim(), phoneKey, status:initialStatus,
      receiptImage: receiptDataUrl || null, /* صورة وصل اختيارية */
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), currentSession:null
    });
    this.id = newDoc.id; this.fullName = fullName.trim(); this.phone = phone.trim(); this.status = initialStatus;
    lsSet('student_id', this.id); lsSet('student_name', this.fullName); lsSet('student_phone', this.phone);
    if(initialStatus === 'approved') await this.startApprovedSession();
    return { ok:true, status:initialStatus, fullName:this.fullName };
  },

  /* محاولة استرجاع جلسة محفوظة محليًا عند فتح التطبيق */
  async resume(){
    if(!fbReady) return false;
    const id = lsGet('student_id'), name = lsGet('student_name'), session = lsGet('student_session');
    if(!id || !session) return false;
    try{
      const snap = await db.collection('students').doc(id).get();
      if(!snap.exists) return false;
      const data = snap.data();
      if(data.status !== 'approved' || data.currentSession !== session) return false;
      this.id = id; this.fullName = data.fullName; this.status = 'approved'; this.sessionId = session;
      this.lastQuestionAt = data.lastQuestionAt || null;
      this.watchSession();
      await this.updateStreak();
      return true;
    }catch(e){ return false; }
  },

  /* مراقبة الجلسة: إن تغيّرت (دخول من جهاز آخر) نخرج تلقائيًا */
  watchSession(){
    if(!fbReady || !this.id) return;
    if(this.unsubscribe) this.unsubscribe();
    this.unsubscribe = db.collection('students').doc(this.id).onSnapshot(snap=>{
      if(!snap.exists) return;
      const data = snap.data();
      if(data.currentSession && this.sessionId && data.currentSession !== this.sessionId){
        alert('تم تسجيل دخولك من جهاز آخر، سيتم إنهاء هذه الجلسة.');
        Student.logout();
        location.reload();
      }
      if(data.lastQuestionAt) this.lastQuestionAt = data.lastQuestionAt;
      /* حقول الترتيب المخزَّنة مسبقًا (تُحدَّث مرة كل 24 ساعة ضمن state/leaderboardCache) —
         تصل هنا تلقائيًا مع نفس الاتصال الحي بوثيقة التلميذ، بلا أي قراءة إضافية */
      this.lessonsRank = (typeof data.lessonsRank === 'number') ? data.lessonsRank : null;
      this.lessonsScore = (typeof data.lessonsScore === 'number') ? data.lessonsScore : null;
      this.examsRank = (typeof data.examsRank === 'number') ? data.examsRank : null;
      this.examsPoints = (typeof data.examsPoints === 'number') ? data.examsPoints : null;
      this.combinedRank = (typeof data.combinedRank === 'number') ? data.combinedRank : null;
      this.combinedScore = (typeof data.combinedScore === 'number') ? data.combinedScore : null;
    });
    this.startHeartbeat();
  },

  /* نبضة حضور خفيفة: تحديث lastSeen كل HEARTBEAT_MS (كتابة واحدة صغيرة فقط، بلا أي قراءة)
     حتى تعرف صفحة الأستاذ عدد المتصلين الآن بدقة معقولة، دون تكرار مشكلة الاستهلاك القديم
     (كانت القراءة تتم سابقًا عند كل تلميذ لكل التلاميذ كل 30 ثانية). تتوقف تلقائيًا إن غادر
     التلميذ التبويب (visibilitychange) توفيرًا إضافيًا، وتُستأنف عند عودته. */
  HEARTBEAT_MS: 3*60*1000,
  _heartbeatTimer:null,
  startHeartbeat(){
    if(!fbReady || !this.id) return;
    this.stopHeartbeat();
    const tick = ()=>{
      if(!this.id || document.visibilityState !== 'visible') return;
      db.collection('students').doc(this.id).update({ lastSeen:firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    };
    tick(); /* نبضة فورية عند بدء الجلسة */
    this._heartbeatTimer = setInterval(tick, this.HEARTBEAT_MS);
    if(!this._visibilityBound){
      this._visibilityBound = true;
      document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') tick(); });
    }
  },
  stopHeartbeat(){
    if(this._heartbeatTimer){ clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  },

  logout(){
    if(this.unsubscribe) this.unsubscribe();
    this.stopHeartbeat();
    localStorage.removeItem('student_id'); localStorage.removeItem('student_name'); localStorage.removeItem('student_session'); localStorage.removeItem('student_phone');
    this.id=null; this.fullName=null; this.phone=null; this.status=null; this.sessionId=null;
  }
};

/* =========================================================================================
   تحديث دوري "واعٍ بحالة ظهور الصفحة" — يوقف القراءات الدورية تمامًا حين يكون التبويب في
   الخلفية (مثلاً تلميذ ترك المنصة مفتوحة في تبويب دون استعمال)، ويستأنفها فور عودته للتبويب.
   هذا يوفّر جزءًا إضافيًا مهمًا من حصة Firestore المجانية اليومية، لأن كثيرًا من التلاميذ
   يتركون التطبيق مفتوحًا لساعات دون أن يكون التبويب مرئيًا فعليًا. */
function startVisibilityAwarePolling(refreshFn, intervalMs){
  let timer = null;
  const start = ()=>{ if(timer) return; refreshFn(); timer = setInterval(refreshFn, intervalMs); };
  const stop = ()=>{ if(timer){ clearInterval(timer); timer = null; } };
  if(document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible') start(); else stop();
  });
}

/* =========================================================================================
   حالة قفل/فتح الدروس والفصول (يتحكم بها الأستاذ/المشرف من داخل التطبيق)
   وثيقة واحدة: state/locks  =>  { lessons: {lessonId: true/false}, trimesters: {t1:bool, t2:bool, t3:bool} }
   ========================================================================================= */
const Locks = {
  data:{ lessons:{}, trimesters:{t1:false, t2:false, t3:false}, situations:{}, features:{irab:true} }, ready:false,

  async load(){
    if(!fbReady) { this.ready = true; return; }
    try{
      const snap = await db.collection('state').doc('locks').get();
      if(snap.exists) this.data = Object.assign({lessons:{}, trimesters:{t1:false,t2:false,t3:false}, situations:{}, features:{irab:true}}, snap.data());
    }catch(e){
      /* هذا الخطأ يخفي المشكلة الحقيقية غالبًا: عدم سماح قواعد Firestore بقراءة state/locks
         بدون Firebase Auth. لو فشلت هذه القراءة، تبقى كل الدروس تظهر "مقفلة" حتى لو فتحها
         الأستاذ فعليًا، لأن this.data يبقى على قيمته الافتراضية الفارغة. */
      console.error('تعذّرت قراءة حالة القفل (state/locks) — تحقق من قواعد Firestore:', e);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
    }
    this.ready = true;
  },
  isLessonLocked(id){ return !this.data.lessons || this.data.lessons[id] !== true; }, // افتراضيًا مقفل حتى يُفتح صراحة
  isTrimesterOpen(t){ return !!(this.data.trimesters && this.data.trimesters[t]); },
  isSituationLocked(key){ return !this.data.situations || this.data.situations[key] !== true; }, // افتراضيًا مقفل حتى يُفتح صراحة
  /* قسم "إعراب الجمل": يبقى مفتوحًا افتراضيًا (كما كان الحال قبل إضافة هذا القفل)
     ولا يُغلق إلا إذا أوقفه الأستاذ صراحة من لوحة التحكم */
  isIrabOpen(){ return !this.data.features || this.data.features.irab !== false; },

  async setLesson(id, open){
    if(!fbReady) return;
    this.data.lessons = this.data.lessons || {};
    this.data.lessons[id] = !!open;
    /* وقت فتح الدرس — يُستعمل لعرض آخر درس مفتوح في أعلى قائمة الدروس */
    if(open){ this.data.openedAt = this.data.openedAt || {}; this.data.openedAt[id] = Date.now(); }
    await db.collection('state').doc('locks').set(this.data, {merge:true});
  },
  async setTrimester(t, open){
    if(!fbReady) return;
    this.data.trimesters = this.data.trimesters || {};
    this.data.trimesters[t] = !!open;
    await db.collection('state').doc('locks').set(this.data, {merge:true});
  },
  async setSituation(key, open){
    if(!fbReady) return;
    this.data.situations = this.data.situations || {};
    this.data.situations[key] = !!open;
    await db.collection('state').doc('locks').set(this.data, {merge:true});
  },
  async setIrabOpen(open){
    if(!fbReady) return;
    this.data.features = this.data.features || {};
    this.data.features.irab = !!open;
    await db.collection('state').doc('locks').set(this.data, {merge:true});
  },

  /* تحديث دوري خفيف بدل الاستماع اللحظي الدائم: قراءة واحدة فقط كل مرة، تُكرَّر كل بضع دقائق
     عبر مؤقّت (setInterval) بدل onSnapshot. السبب: onSnapshot يبقي اتصالاً مفتوحًا مع كل زائر
     (400+ تلميذ)، فأي تعديل واحد من الأستاذ على هذه الوثيقة المشتركة يُنتج فورًا 400+ قراءة
     دفعة واحدة (كلفة "البث للجميع")، وهو ما يستنزف حصة Firestore المجانية اليومية بسرعة كبيرة.
     القراءة الدورية (كل 3 دقائق تقريبًا) تكفي تمامًا لهذا النوع من البيانات (حالة فتح/إغلاق
     الدروس)، وتُخفّض الكلفة من "قراءة واحدة لكل تعديل × كل التلاميذ المتصلين" إلى
     "قراءة واحدة لكل تلميذ كل 3 دقائق" فقط. */
  listen(onChange){
    if(!fbReady) return;
    const refresh = ()=> db.collection('state').doc('locks').get().then(snap=>{
      if(snap.exists) this.data = Object.assign({lessons:{}, trimesters:{t1:false,t2:false,t3:false}, situations:{}, features:{irab:true}}, snap.data());
      if(onChange) onChange();
    }).catch(error=>{
      console.error('تعذّرت قراءة حالة القفل (state/locks) — تحقق من قواعد Firestore:', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
    });
    startVisibilityAwarePolling(refresh, 3 * 60 * 1000);
  }
};

/* =========================================================================================
   روابط تسجيلات حصص الزوم للأفواج الأربعة (يديرها الأستاذ من لوحة التحكم)
   وثيقة واحدة: state/zoomLinks
   => { lessons: { lessonId: { g1:{video,summary,exercises}, g2:{...}, g3:{...}, g4:{...} } } }
   كل فوج له 3 روابط مستقلة: فيديو الحصة، ملخّص الدرس، تمارين الدرس — لأن كل فوج قد يملك
   وثائق ومواعيد مختلفة عن الآخر. نفس نمط وحدة Locks تمامًا: تحميل مرة واحدة + استماع لحظي
   لانعكاس أي تحديث فورًا عند كل التلاميذ دون الحاجة لإعادة تحميل الصفحة، ودون أي تعديل
   مستقبلي على الكود عند إضافة دروس جديدة.
   ========================================================================================= */
/* يوحّد أي قيمة قديمة (رابط واحد كنص) أو جديدة (مصفوفة روابط) إلى مصفوفة نصوص نظيفة دون فراغات،
   حتى تبقى البيانات القديمة المحفوظة قبل هذا التحديث صالحة للعرض دون أي عملية ترحيل يدوية */
function normalizeZoomLinkList(v){
  if(Array.isArray(v)) return v.map(x=> String(x==null?'':x).trim()).filter(Boolean);
  if(typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

const ZoomLinks = {
  data:{ lessons:{} }, ready:false,

  async load(){
    if(!fbReady){ this.ready = true; return; }
    try{
      const snap = await db.collection('state').doc('zoomLinks').get();
      if(snap.exists) this.data = Object.assign({lessons:{}}, snap.data());
    }catch(e){
      console.error('تعذّرت قراءة روابط حصص الزوم (state/zoomLinks) — تحقق من قواعد Firestore:', e);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('zoomLinks');
    }
    this.ready = true;
  },

  /* يُعيد دائمًا كائنًا بكل الأفواج، وكل فوج بحقوله الثلاثة كمصفوفات روابط (فارغة إن لم تُحفظ
     بعد) — كل فوج يمكن أن يملك أكثر من رابط فيديو وأكثر من رابط ملخّص وأكثر من رابط تمارين */
  getLinks(lessonId){
    const l = (this.data.lessons && this.data.lessons[lessonId]) || {};
    const out = {};
    ['g1','g2','g3','g4','g5'].forEach(k=>{
      const g = l[k] || {};
      out[k] = {
        video: normalizeZoomLinkList(g.video),
        summary: normalizeZoomLinkList(g.summary),
        exercises: normalizeZoomLinkList(g.exercises)
      };
    });
    return out;
  },

  /* هل يوجد رابط واحد على الأقل (فيديو أو وثيقة) محفوظ لأي فوج في هذا الدرس؟
     (تُستعمل لعرض مؤشر في قائمة الأستاذ) */
  hasAnyLink(lessonId){
    const l = this.getLinks(lessonId);
    return ['g1','g2','g3','g4','g5'].some(k=> l[k].video.length || l[k].summary.length || l[k].exercises.length);
  },

  async setLinks(lessonId, groups){
    if(!fbReady) return { ok:false, reason:'no-firebase' };
    this.data.lessons = this.data.lessons || {};
    const clean = {};
    ['g1','g2','g3','g4','g5'].forEach(k=>{
      const g = groups[k] || {};
      clean[k] = {
        video: normalizeZoomLinkList(g.video),
        summary: normalizeZoomLinkList(g.summary),
        exercises: normalizeZoomLinkList(g.exercises)
      };
    });
    this.data.lessons[lessonId] = clean;
    await db.collection('state').doc('zoomLinks').set(this.data, {merge:true});
    return { ok:true };
  },

  /* تحديث دوري بدل الاستماع اللحظي الدائم — نفس السبب الموضَّح أعلاه في Locks.listen */
  listen(onChange){
    if(!fbReady) return;
    const refresh = ()=> db.collection('state').doc('zoomLinks').get().then(snap=>{
      if(snap.exists) this.data = Object.assign({lessons:{}}, snap.data());
      if(onChange) onChange();
    }).catch(error=>{
      console.error('تعذّرت قراءة روابط حصص الزوم (state/zoomLinks) — تحقق من قواعد Firestore:', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('zoomLinks');
    });
    startVisibilityAwarePolling(refresh, 3 * 60 * 1000);
  }
};

/* =========================================================================================
   روابط الفروض والاختبارات لكل فصل — موحّدة لجميع الأفواج (بخلاف روابط حصص الزوم)
   وثيقة واحدة: state/examLinks => { t1:[{title,link}], t2:[...], t3:[...] }
   نفس فكرة رفع الدروس/التمارين عبر رابط (تيليجرام أو أي رابط آخر)، لكن دون تكرار لكل فوج،
   لأن الفروض والاختبارات نفسها تخصّ كل التلاميذ بلا استثناء.
   ========================================================================================= */
const ExamLinks = {
  data:{ t1:[], t2:[], t3:[] }, ready:false,

  async load(){
    if(!fbReady){ this.ready = true; return; }
    try{
      const snap = await db.collection('state').doc('examLinks').get();
      if(snap.exists) this.data = Object.assign({t1:[],t2:[],t3:[]}, snap.data());
    }catch(e){
      console.error('تعذّرت قراءة روابط الفروض والاختبارات (state/examLinks) — تحقق من قواعد Firestore:', e);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('examLinks');
    }
    this.ready = true;
  },

  /* يُعيد دائمًا مصفوفة عناصر {title, link} نظيفة (بلا فراغات، وبلا عناصر بلا رابط) لفصل معيّن */
  getItems(t){
    const arr = Array.isArray(this.data[t]) ? this.data[t] : [];
    return arr
      .map(x=> ({ title:String((x && x.title) || '').trim(), link:String((x && x.link) || '').trim() }))
      .filter(x=> x.link);
  },

  async setItems(t, items){
    if(!fbReady) return { ok:false, reason:'no-firebase' };
    const clean = (items||[])
      .map(x=> ({ title:String(x.title||'').trim(), link:String(x.link||'').trim() }))
      .filter(x=> x.link);
    this.data[t] = clean;
    await db.collection('state').doc('examLinks').set(this.data, {merge:true});
    return { ok:true };
  },

  /* تحديث دوري بدل الاستماع اللحظي الدائم — نفس السبب الموضَّح أعلاه في Locks.listen */
  listen(onChange){
    if(!fbReady) return;
    const refresh = ()=> db.collection('state').doc('examLinks').get().then(snap=>{
      if(snap.exists) this.data = Object.assign({t1:[],t2:[],t3:[]}, snap.data());
      if(onChange) onChange();
    }).catch(error=>{
      console.error('تعذّرت قراءة روابط الفروض والاختبارات (state/examLinks) — تحقق من قواعد Firestore:', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('examLinks');
    });
    startVisibilityAwarePolling(refresh, 3 * 60 * 1000);
  }
};

/* =========================================================================================
   لوحة تحكم الأستاذ/المشرف — الرقم السري + طلبات الانتظار + الإحصائيات
   ========================================================================================= */
const Admin = {
  authed:false,

  checkPin(pin){
    if(pin === (window.ADMIN_PIN || '')){ this.authed = true; return true; }
    return false;
  },

  async listPending(){
    if(!fbReady) return [];
    const snap = await db.collection('students').where('status','==','pending').get();
    return snap.docs.map(d=>({ id:d.id, ...d.data() }));
  },
  /* استماع لحظي لطلبات التسجيل الجديدة (قيد الانتظار) — أي طلب جديد ينعكس فورًا في لوحة
     التحكم إن كانت مفتوحة حاليًا، دون الحاجة لإعادة تحميل الصفحة يدويًا.
     ⚠️ يجب تفعيله فقط بعد تسجيل دخول الأستاذ (وليس عند فتح الموقع لأي زائر)، لأن onSnapshot
     يُحتسب قراءة لكل تلميذ في نتيجة الاستعلام، لكل عميل مشترك، عند كل تغيير — فلو اشترك كل
     تلميذ زائر للموقع في هذا الاستماع (كما كان يحدث سابقًا)، كل طلب تسجيل جديد يصل يُضاعِف
     عدد القراءات بعدد كل التلاميذ المتصلين في تلك اللحظة. هذا كان على الأرجح السبب الرئيسي
     لاستنفاد حصة القراءات. */
  _pendingUnsub: null,
  listenPending(onChange){
    if(!fbReady) return;
    if(this._pendingUnsub) return; /* مُفعَّل مسبقًا، لا داعي للاشتراك مرتين */
    this._pendingUnsub = db.collection('students').where('status','==','pending').onSnapshot(()=>{
      if(onChange) onChange();
    }, error=>{
      console.error('تعذّر الاستماع لطلبات الانتظار — تحقق من قواعد Firestore:', error);
    });
  },
  stopListenPending(){
    if(this._pendingUnsub){ this._pendingUnsub(); this._pendingUnsub = null; }
  },
  /* حذف صورة الوصل تلقائيًا من الوثيقة فور اتخاذ القرار — لا نُبقي أي صورة مخزَّنة بعد المعالجة */
  async approve(id){ if(fbReady) await db.collection('students').doc(id).update({status:'approved', receiptImage: firebase.firestore.FieldValue.delete()}); },
  async reject(id){ if(fbReady) await db.collection('students').doc(id).update({status:'rejected', receiptImage: firebase.firestore.FieldValue.delete()}); },

  /* إحصائيات درس واحد من مجموعة submissions (تُملأ لاحقًا عند إضافة "تمارين الدرس") */
  async lessonStats(lessonId, totalStudents){
    if(!fbReady) return { participants:0, total:totalStudents||0, avg:0 };
    try{
      const snap = await db.collection('submissions').doc(lessonId).collection('students').get();
      let sum = 0, count = 0;
      snap.forEach(d=>{ const dd=d.data(); if(dd.completed===false) return; const v = dd.percent; if(typeof v === 'number'){ sum += v; count++; } });
      return { participants:count, total: totalStudents||count, avg: count ? Math.round(sum/count) : 0 };
    }catch(e){ return { participants:0, total:totalStudents||0, avg:0 }; }
  },

  /* ====== ذاكرة تخزين مؤقت (Cache) موحّدة لقائمة التلاميذ المقبولين ======
     المشكلة التي كانت تستنزف حصة القراءات: 4 دوال منفصلة (allStudentsCount،
     studentsCounts، listApproved، listApprovedFull) كل واحدة تعيد قراءة كامل
     مجموعة "students" بحالة approved من جديد — وأخطر من ذلك، renderAdminPanel()
     يستدعي studentsCounts() في كل مرة يفتح فيها الأستاذ اللوحة، وأيضًا تلقائيًا
     عبر Admin.listenPending() في كل مرة يصل فيها طلب تسجيل جديد (onSnapshot).
     مع كثرة الطلبات، هذا يعني إعادة قراءة كل تلميذ مقبول (قد يكونوا المئات) في
     كل مرة يصل فيها طلب واحد فقط — وهذا على الأرجح السبب الرئيسي لاستنفاد الحصة.
     الحل: قراءة واحدة تُخزَّن لمدة APPROVED_CACHE_MS ثم تُعاد استعمالها من طرف
     الدوال الأربع، بدل قراءة منفصلة لكل واحدة وفي كل استدعاء. */
  APPROVED_CACHE_MS: 60*1000,
  _approvedCache: null,
  _approvedCacheAt: 0,
  async _getApprovedDocs(forceRefresh){
    if(!fbReady) return [];
    const fresh = this._approvedCache && (Date.now() - this._approvedCacheAt) < this.APPROVED_CACHE_MS;
    if(fresh && !forceRefresh) return this._approvedCache;
    const snap = await db.collection('students').where('status','==','approved').get();
    this._approvedCache = snap.docs;
    this._approvedCacheAt = Date.now();
    return this._approvedCache;
  },

  async allStudentsCount(){
    const docs = await this._getApprovedDocs();
    return docs.length;
  },

  /* عدد التلاميذ المتصلين الآن (lastSeen خلال آخر ONLINE_WINDOW_MS) — تستعمل نفس
     الكاش الموحَّد أعلاه بدل قراءة منفصلة. */
  ONLINE_WINDOW_MS: 6*60*1000,
  async studentsCounts(){
    const docs = await this._getApprovedDocs();
    const now = Date.now();
    let online = 0;
    docs.forEach(d=>{
      const ls = d.data().lastSeen;
      const ms = ls && typeof ls.toMillis === 'function' ? ls.toMillis() : null;
      if(ms && (now - ms) <= this.ONLINE_WINDOW_MS) online++;
    });
    return { total: docs.length, online };
  },

  /* قائمة أسماء كل التلاميذ المقبولين، مرتبة أبجديًا */
  async listApproved(){
    const docs = await this._getApprovedDocs();
    const names = docs.map(d=>d.data().fullName);
    names.sort((a,b)=> a.localeCompare(b, 'ar'));
    return names;
  },

  /* قائمة كاملة (المعرّف + الاسم) لكل التلاميذ المقبولين، مرتبة أبجديًا */
  async listApprovedFull(){
    const docs = await this._getApprovedDocs();
    const list = docs.map(d=>({
      id:d.id, fullName:d.data().fullName,
      completedExercisesCount: d.data().completedExercisesCount,
      totalScoreSum: d.data().totalScoreSum
    }));
    list.sort((a,b)=> a.fullName.localeCompare(b.fullName, 'ar'));
    return list;
  },

  /* متوسط مستوى تلميذ في تمارين كل الدروس (بالنسبة المئوية)، أو null إن لم يشارك في أي تمرين بعد */
  async studentAverage(studentId){
    if(!fbReady) return null;
    const lessons = window.LESSONS.filter(l=>l.locked!=='pending');
    /* قراءة نتائج كل الدروس بالتوازي بدل التسلسل، حتى لا تتباطأ الصفحة كلما زاد عدد الدروس */
    const docs = await Promise.all(lessons.map(l=>
      db.collection('submissions').doc(l.id).collection('students').doc(studentId).get().catch(()=>null)
    ));
    const percents = docs
      .filter(doc=> doc && doc.exists && doc.data().completed !== false && typeof doc.data().percent === 'number')
      .map(doc=> doc.data().percent);
    if(!percents.length) return null;
    return Math.round(percents.reduce((a,b)=>a+b,0) / percents.length);
  }
};

/* =========================================================================================
   الترتيب (Leaderboard) لتمارين الدرس — بالنسبة المئوية، وليس بمجموع نقاط
   ========================================================================================= */
const Leaderboard = {
  /* الترتيب حسب النسبة المئوية تنازليًا، وعند التعادل يُفصل بينهم بأقل وقت استغرقه إنجاز التمرين
     (timeSeconds) — من لم تُسجَّل مدته (نتائج قديمة قبل هذه الميزة) يُوضع في آخر مجموعة التعادل. */
  _rank(a, b){
    if((b.percent||0) !== (a.percent||0)) return (b.percent||0) - (a.percent||0);
    const ta = (typeof a.timeSeconds === 'number') ? a.timeSeconds : Infinity;
    const tb = (typeof b.timeSeconds === 'number') ? b.timeSeconds : Infinity;
    return ta - tb;
  },
  async forLesson(lessonId){
    if(!fbReady) return [];
    /* الجلب بلا ترتيب من الخادم (تفاديًا لفهرس مركّب في Firestore)، ثم الترتيب محليًا حسب
       النسبة المئوية فأقل وقت عند التعادل. تُستبعد المحاولات غير المكتملة (completed:false) من الترتيب. */
    const snap = await db.collection('submissions').doc(lessonId).collection('students').limit(3000).get();
    const rows = snap.docs.filter(d=> d.data().completed !== false)
      .map(d=>({ name:d.data().studentName, percent:d.data().percent, timeSeconds:d.data().timeSeconds }));
    rows.sort(Leaderboard._rank);
    return rows.slice(0, 50);
  },
  /* نتيجة التلميذ الحالي في تمرين درس معيّن، إن وُجدت (لمنع إعادة المحاولة وعرض نتيجته السابقة).
     completed:false تعني أنّ التلميذ بدأ التمرين ولم يُتمّه بعد (تُسجَّل تدريجيًا تمرينًا بتمرين) —
     السجلات القديمة لا تحمل هذا الحقل إطلاقًا وتُعتبر دائمًا مكتملة (توافقًا مع البيانات السابقة). */
  async mine(lessonId){
    if(!fbReady || !Student.id) return null;
    try{
      const doc = await db.collection('submissions').doc(lessonId).collection('students').doc(Student.id).get();
      return doc.exists ? doc.data() : null;
    }catch(e){ return null; }
  },
  LESSON_CACHE_MAX_AGE_MS: 2 * 60 * 60 * 1000,

  /* ---------- تخزين مؤقت لترتيب درس واحد (ساعة واحدة) ----------
     نفس فكرة تخزين الترتيب العام: بدل قراءة نتائج كل تلميذ أنجز الدرس في كل مرة يفتح فيها أي
     تلميذ ترتيب ذلك الدرس، نحسبه مرة واحدة كل 24 ساعة فقط (أول من يفتحه بعد انتهاء الصلاحية
     يتحمّل القراءة الكاملة نيابة عن الجميع)، ونخزّن أفضل 3 + خريطة (معرّف التلميذ → مرتبته) في
     مستند واحد صغير يقرأه الجميع بقراءة واحدة. مرتبة التلميذ نفسه تُستخرج من نفس الخريطة، ونتيجته
     التفصيلية (النسبة/الوقت) تُجلب بقراءة واحدة خفيفة من submissions عبر mine() فقط إن احتاجها. */
  async refreshLessonIfStale(lessonId){
    if(!fbReady) return null;
    const ref = db.collection('lessonLeaderboardCache').doc(lessonId);
    let cache = null;
    try{
      const snap = await ref.get();
      cache = snap.exists ? snap.data() : null;
    }catch(e){ console.error('تعذّرت قراءة lessonLeaderboardCache:', e); }
    const age = cache && cache.updatedAt && typeof cache.updatedAt.toMillis === 'function'
      ? (Date.now() - cache.updatedAt.toMillis()) : Infinity;
    if(cache && age < this.LESSON_CACHE_MAX_AGE_MS) return cache;

    /* منتهي الصلاحية أو غائب: نعيد الحساب الكامل لهذا الدرس فقط (مرة كل 24 ساعة كحد أقصى) */
    try{
      const snap = await db.collection('submissions').doc(lessonId).collection('students').limit(3000).get();
      const rows = [];
      snap.forEach(d=>{
        const data = d.data();
        if(data.completed === false) return;
        rows.push({ studentId:d.id, name:data.studentName, percent:data.percent, timeSeconds:data.timeSeconds, submittedAt:data.submittedAt });
      });
      rows.sort(this._rank);
      const ranks = {};
      rows.forEach((r,i)=>{ ranks[r.studentId] = i+1; });
      const newCache = {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        participantsCount: rows.length,
        top10: rows.slice(0,10),
        ranks
      };
      await ref.set(newCache);
      return Object.assign({}, newCache, { updatedAt:{ toMillis:()=>Date.now() } });
    }catch(e){
      console.error('تعذّر إعادة حساب ترتيب الدرس:', e);
      return cache; // نُبقي على القديم إن فشلت إعادة الحساب
    }
  },
  /* بدء محاولة التمرين: يُنشئ سجلًا فوريًا في قاعدة البيانات بمجرد الضغط على "ابدأ التمرين"،
     حتى لا يستطيع التلميذ إعادة المحاولة بمجرد تحديث الصفحة قبل إتمام كل التمارين. */
  async startAttempt(lessonId){
    if(!fbReady || !Student.id) return { ok:false, reason:'offline' };
    const ref = db.collection('submissions').doc(lessonId).collection('students').doc(Student.id);
    try{
      const existing = await ref.get();
      if(existing.exists) return { ok:false, reason:'already-started', data: existing.data() };
      await ref.set({
        studentName: Student.fullName, percent:0, sectionsDone:0, completed:false,
        startedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok:true };
    }catch(e){ return { ok:false, reason:'error' }; }
  },
  /* حفظ التقدّم فور إتمام كل تمرين فرعي (بعد الضغط على «تحقق»)، حتى تُحسب النتيجة تدريجيًا ولا
     تُفقد المحاولة بتحديث الصفحة في منتصف الطريق. scoreSum: مجموع النقاط الخام (بين 0 و1 لكل
     تمرين فرعي) يُحفظ بجانب النسبة المئوية حتى يمكن استئناف التمرين لاحقًا بدقة بلا فقدان كسور
     النقاط بسبب التقريب. لا يُغيّر completed إلا الإرسال النهائي submit(). */
  async saveProgress(lessonId, sectionsDone, partialPercent, scoreSum){
    if(!fbReady || !Student.id) return;
    const ref = db.collection('submissions').doc(lessonId).collection('students').doc(Student.id);
    try{ await ref.update({ sectionsDone, percent: partialPercent, scoreSum }); }catch(e){ /* تجاهل صامت */ }
  },
  /* تسجيل نتيجة تمرين درس نهائيًا — محاولة واحدة فقط. timeSeconds: المدة بالثواني من بدء التمرين إلى
     إرساله، تُستخدم فقط للفصل بين المتعادلين في النسبة المئوية داخل الترتيب */
  async submit(lessonId, percent, timeSeconds){
    if(!fbReady || !Student.id) return { ok:false, reason:'offline' };
    const ref = db.collection('submissions').doc(lessonId).collection('students').doc(Student.id);
    try{
      const existing = await ref.get();
      if(existing.exists && existing.data().completed !== false) return { ok:false, reason:'already-submitted' }; // محاولة واحدة فقط
      const payload = { studentName: Student.fullName, percent, completed:true, submittedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if(typeof timeSeconds === 'number' && isFinite(timeSeconds) && timeSeconds >= 0) payload.timeSeconds = timeSeconds;
      await ref.set(payload, { merge:true });
      /* تحديث تراكمي فوري (بزيادة ذرّية، بلا قراءة إضافية) لمجموع النقاط وعدد التمارين المنجزة
         في مستند التلميذ نفسه، حتى تُحسب لوحة الإدارة ولوحة الشرف العامة المعدّل من هذا الحقل
         الجاهز مباشرة بدل إعادة قراءة نتائج كل الدروس من جديد في كل مرة (يوفّر آلاف القراءات
         مع عدد كبير من التلاميذ). لا يؤثر فشل هذه الخطوة على نجاح تسجيل النتيجة الأساسية. */
      db.collection('students').doc(Student.id).update({
        completedExercisesCount: firebase.firestore.FieldValue.increment(1),
        totalScoreSum: firebase.firestore.FieldValue.increment(percent)
      }).catch(()=>{});
      return { ok:true };
    }catch(e){ return { ok:false, reason:'error' }; }
  },

  /* ---------- الترتيب الشامل (لوحة الشرف العامة) — مجموع نتائج كل تلميذ في تمارين الدروس المنجزة ----------
     يجمع نتائج كل تلميذ عبر جميع الدروس المتوفرة (وليس درسًا واحدًا فقط)، ويرتّبهم تنازليًا حسب
     مجموع نتائجهم الإجمالية. يُعاد أيضًا متوسط النسبة المئوية وعدد التمارين المنجزة لكل تلميذ. */
  async overallLessons(){
    if(!fbReady) return [];
    /* بدل تكرار قراءة نتائج كل تلميذ عبر كل درس (تكلفة: عدد التلاميذ × عدد الدروس)، تُقرأ
       مجموعة التلاميذ المقبولين مرة واحدة فقط، ويُستعمل مجموع النقاط التراكمي (totalScoreSum)
       وعدد التمارين المنجزة (completedExercisesCount) المحفوظان مسبقًا في مستند كل تلميذ
       (يُحدَّثان لحظيًا في Submissions.submit عند كل تمرين جديد). */
    try{
      const snap = await db.collection('students').where('status','==','approved').get();
      const results = [];
      snap.forEach(doc=>{
        const data = doc.data();
        const count = (typeof data.completedExercisesCount === 'number') ? data.completedExercisesCount : 0;
        if(count <= 0) return; // لم يشارك بعد في أي تمرين
        const total = (typeof data.totalScoreSum === 'number') ? data.totalScoreSum : 0;
        results.push({
          studentId: doc.id, name: data.fullName || 'طالب غير معروف',
          totalScore: Math.round(total*10)/10, avgPercent: Math.round(total/count), exercisesCount: count
        });
      });
      /* الترتيب التنازلي حسب مجموع النتائج الإجمالية */
      results.sort((a,b)=> b.totalScore - a.totalScore);
      return results;
    }catch(e){ return []; }
  },

  /* ---------- ترتيب الفروض والاختبارات — مجموع النقاط المتحصل عليها لكل تلميذ عبر كل الفروض/الاختبارات المنجزة ----------
     منذ ربط صفحة تسليم الفرض/الاختبار بحساب التلميذ، تحمل كل نتيجة جديدة studentId مباشرة، فيُجمَّع
     بحسبه (دقيق 100%، بلا أي التباس بين الأسماء). النتائج القديمة (قبل هذا الربط) لا تحمل studentId
     فتبقى مجمَّعة بحسب الاسم المكتوب كما كانت، لضمان عدم فقدان أي نتيجة قديمة. */
  async overallExams(){
    if(!fbReady) return [];
    const byKey = new Map(); // key -> {name, studentId, total, count}
    try{
      /* قراءة تسليمات كل الفروض/الاختبارات بالتوازي بدل التسلسل، حتى لا تتباطأ الصفحة
         كلما زاد عدد الفروض والاختبارات */
      const examsSnap = await db.collection('exams').get();
      const subsSnaps = await Promise.all(examsSnap.docs.map(examDoc=>
        db.collection('exams').doc(examDoc.id).collection('submissions').get().catch(()=>null)
      ));
      subsSnaps.forEach(subsSnap=>{
        if(!subsSnap) return;
        /* بعض التلاميذ يسلّمون نفس الفرض/التمرين أكثر من مرة (مثلاً بعد تحديث الصفحة أو عدم
           تسجيل الدخول بنفس الحساب في المرة الثانية)، فتتكوّن أكثر من وثيقة تسليم لنفس الطالب
           في نفس الاختبار. لتفادي احتساب هذا الاختبار مرتين، ولتفادي إمكانية أن ينقل التلميذ
           تصحيح المحاولة الأولى ثم يعيد الحلّ للحصول على نتيجة أفضل، نحتسب دائمًا المحاولة
           الأولى (الأقدم زمنيًا) فقط لكل طالب داخل كل اختبار، بغضّ النظر عن نتيجة أي محاولة لاحقة. */
        const firstPerStudentInExam = new Map(); // key -> {name, studentId, score, submittedAtMs}
        subsSnap.forEach(doc=>{
          const data = doc.data();
          const name = (data.studentName || '').trim();
          if(!name || typeof data.score !== 'number') return;
          const key = data.studentId ? ('id:'+data.studentId) : ('name:'+name.toLowerCase());
          const ts = data.submittedAt && data.submittedAt.toMillis ? data.submittedAt.toMillis() : Infinity;
          const existing = firstPerStudentInExam.get(key);
          if(!existing || ts < existing.submittedAtMs){
            firstPerStudentInExam.set(key, { name, studentId: data.studentId || null, score: data.score, submittedAtMs: ts });
          }
        });
        firstPerStudentInExam.forEach((first, key)=>{
          const entry = byKey.get(key) || { name: first.name, studentId: first.studentId, total:0, count:0 };
          entry.total += first.score;
          entry.count += 1;
          entry.name = first.name || entry.name;
          byKey.set(key, entry);
        });
      });
    }catch(e){}
    const results = Array.from(byKey.values()).map(e=>({
      name: e.name, studentId: e.studentId, totalPoints: Math.round(e.total*100)/100, examsCount: e.count
    }));
    /* الترتيب التنازلي حسب مجموع النقاط المتحصل عليها */
    results.sort((a,b)=> b.totalPoints - a.totalPoints);
    return results;
  },

  /* ---------- الترتيب الشامل الكامل: تمارين الدروس + الفروض والاختبارات معًا ----------
     تمارين الدروس مرتبطة دائمًا بحساب التلميذ (studentId). أما الفروض والاختبارات فتُطابَق أولًا
     بحساب التلميذ (studentId) إن كانت النتيجة مسجَّلة بعد ربط صفحة التسليم بالحساب، وإلا فبمطابقة
     الاسم الكامل كحلٍّ احتياطي للنتائج القديمة فقط. */
  async overallCombined(){
    if(!fbReady) return [];
    const [lessonResults, examResults, approvedStudents] = await Promise.all([
      this.overallLessons(), this.overallExams(), Admin.listApprovedFull()
    ]);
    const lessonByStudentId = new Map(lessonResults.map(r=> [r.studentId, r.totalScore]));
    const examByStudentId = new Map(examResults.filter(r=> r.studentId).map(r=> [r.studentId, r.totalPoints]));
    const examByName = new Map(examResults.map(r=> [(r.name||'').trim().toLowerCase(), r.totalPoints]));
    const combined = approvedStudents.map(s=>{
      const lessonScore = lessonByStudentId.get(s.id) || 0;
      const examScore = examByStudentId.has(s.id)
        ? examByStudentId.get(s.id)
        : (examByName.get((s.fullName||'').trim().toLowerCase()) || 0);
      return {
        studentId: s.id, name: s.fullName, lessonScore, examScore,
        totalScore: Math.round((lessonScore + examScore) * 10) / 10
      };
    });
    /* الترتيب التنازلي حسب المجموع الشامل */
    combined.sort((a,b)=> b.totalScore - a.totalScore);
    return combined;
  },

  /* ---------- تخزين مؤقت للترتيب (24 ساعة) ----------
     المشكلة: فتح صفحة الترتيب كان يقرأ كل مستندات التلاميذ 3 مرات (overallLessons + overallExams +
     listApprovedFull) في كل مرة يفتحها أي تلميذ — بعدد كبير من التلاميذ هذا يستنزف حصة القراءات
     المجانية اليومية من Firestore خلال دقائق.
     الحل: نحسب الترتيب الكامل مرة واحدة كل ساعة فقط (أول من يفتح الصفحة بعد انتهاء الصلاحية
     يتحمّل هذه القراءة الكاملة نيابة عن الجميع)، ونخزّن أفضل 10 في مستند واحد صغير (state/
     leaderboardCache) يقرأه الجميع بقراءة واحدة فقط. أما "مرتبة التلميذ نفسه"، فتُكتب داخل مستنده
     الشخصي (lessonsRank/examsRank/combinedRank...) الذي يراقبه أصلاً باستمرار عبر watchSession —
     فتصل إليه بلا أي قراءة إضافية إطلاقًا. */
  CACHE_MAX_AGE_MS: 2 * 60 * 60 * 1000,

  async getCache(){
    if(!fbReady) return null;
    try{
      const snap = await db.collection('state').doc('leaderboardCache').get();
      return snap.exists ? snap.data() : null;
    }catch(e){ console.error('تعذّرت قراءة state/leaderboardCache:', e); return null; }
  },

  /* يُعيد نسخة محدَّثة من الترتيب (من التخزين المؤقت إن كان لا يزال صالحًا، أو يُعيد حسابه كاملاً
     إن انتهت صلاحيته — مرة كل 24 ساعة كحد أقصى بغض النظر عن عدد مرات فتح الصفحة). */
  async refreshIfStale(force){
    const cache = await this.getCache();
    const age = cache && cache.updatedAt && typeof cache.updatedAt.toMillis === 'function'
      ? (Date.now() - cache.updatedAt.toMillis()) : Infinity;
    if(!force && cache && age < this.CACHE_MAX_AGE_MS) return cache;

    /* التخزين المؤقت غائب أو منتهي الصلاحية: نعيد الحساب الكامل (هذا هو الجزء المكلف، يحدث
       مرة كل 24 ساعة على الأكثر) */
    try{
      const [lessonResults, examResults, approvedStudents] = await Promise.all([
        this.overallLessons(), this.overallExams(), Admin.listApprovedFull()
      ]);
      const lessonRankByStudent = new Map(lessonResults.map((r,i)=> [r.studentId, i+1]));
      const examRankByStudent = new Map();
      examResults.forEach((r,i)=>{ if(r.studentId) examRankByStudent.set(r.studentId, {rank:i+1, points:r.totalPoints}); });
      const lessonByStudentId = new Map(lessonResults.map(r=> [r.studentId, r.totalScore]));
      const examByStudentId = new Map(examResults.filter(r=> r.studentId).map(r=> [r.studentId, r.totalPoints]));
      const examByName = new Map(examResults.map(r=> [(r.name||'').trim().toLowerCase(), r.totalPoints]));
      const combined = approvedStudents.map(s=>{
        const lessonScore = lessonByStudentId.get(s.id) || 0;
        const examScore = examByStudentId.has(s.id) ? examByStudentId.get(s.id) : (examByName.get((s.fullName||'').trim().toLowerCase()) || 0);
        return { studentId:s.id, totalScore: Math.round((lessonScore+examScore)*10)/10 };
      });
      combined.sort((a,b)=> b.totalScore - a.totalScore);
      const combinedRankByStudent = new Map(combined.map((r,i)=> [r.studentId, i+1]));

      /* كتابة مرتبة كل تلميذ داخل مستنده الشخصي، على دفعات (500 عملية كحد أقصى للدفعة الواحدة
         في Firestore)، حتى تصل له لاحقًا بلا أي قراءة إضافية عبر watchSession */
      const chunks = [];
      for(let i=0;i<approvedStudents.length;i+=450) chunks.push(approvedStudents.slice(i,i+450));
      for(const chunk of chunks){
        const batch = db.batch();
        chunk.forEach(s=>{
          const ref = db.collection('students').doc(s.id);
          batch.update(ref, {
            lessonsRank: lessonRankByStudent.get(s.id) || null,
            lessonsScore: lessonByStudentId.get(s.id) || 0,
            examsRank: (examRankByStudent.get(s.id)||{}).rank || null,
            examsPoints: (examRankByStudent.get(s.id)||{}).points || 0,
            combinedRank: combinedRankByStudent.get(s.id) || null,
            combinedScore: (combined.find(c=>c.studentId===s.id)||{}).totalScore || 0
          });
        });
        await batch.commit().catch(e=> console.error('تعذّر تحديث دفعة مراتب التلاميذ:', e));
      }

      const newCache = {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        totalStudents: approvedStudents.length,
        top10Lessons: lessonResults.slice(0,10),
        top10Exams: examResults.slice(0,10)
      };
      await db.collection('state').doc('leaderboardCache').set(newCache);
      return Object.assign({}, newCache, { updatedAt:{ toMillis:()=>Date.now() } });
    }catch(e){
      console.error('تعذّر إعادة حساب الترتيب:', e);
      return cache; // نُبقي على القديم إن فشلت إعادة الحساب، أفضل من عدم عرض شيء
    }
  }
};

/* تنسيق مدة إنجاز التمرين (بالثواني) بصيغة عربية مختصرة، مثل: "3 د 24 ث" أو "48 ث" */
function formatDurationAr(totalSeconds){
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s/60), r = s%60;
  return m>0 ? `${m} د ${r} ث` : `${r} ث`;
}

/* =========================================================================================
   نافذة ترتيب الدرس (Leaderboard Popup)
   ========================================================================================= */
async function showLeaderboardPopup(lesson){
  if(!fbReady){
    alert('Firebase غير مفعّل. لا يمكن عرض الترتيب.');
    return;
  }
  
  /* إنشاء الـ overlay والـ popup */
  const overlay = document.createElement('div');
  overlay.className = 'leaderboard-overlay';
  
  const popup = document.createElement('div');
  popup.className = 'leaderboard-popup';
  
  /* الهيدر */
  const header = document.createElement('div');
  header.className = 'leaderboard-header';
  
  const title = document.createElement('div');
  title.className = 'leaderboard-title';
  title.textContent = `ترتيب درس: ${lesson.title}`;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'leaderboard-close';
  closeBtn.innerHTML = '✕';
  closeBtn.onclick = ()=>overlay.remove();
  
  header.appendChild(title);
  header.appendChild(closeBtn);
  
  /* قائمة النتائج */
  const listDiv = document.createElement('div');
  listDiv.className = 'leaderboard-list';
  listDiv.innerHTML = '<div class="leaderboard-empty">جاري تحميل النتائج…</div>';
  
  popup.appendChild(header);
  popup.appendChild(listDiv);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  
  /* جلب البيانات من الذاكرة المؤقتة (قراءة واحدة عادةً، أو إعادة حساب كاملة نادرًا لهذا الدرس فقط
     — مرة كل 24 ساعة كحد أقصى، بدل قراءة كل نتائج الدرس في كل فتحة) */
  try{
    const cache = await Leaderboard.refreshLessonIfStale(lesson.id);
    const top10 = (cache && cache.top10) || [];

    if(!top10.length){
      listDiv.innerHTML = '<div class="leaderboard-empty">لا توجد نتائج بعد لهذا الدرس</div>';
      return;
    }

    /* بناء صفّ واحد في القائمة — يُستعمل لعرض العشرة الأوائل، ثم صفّ التلميذ الحالي بمرتبته
       الحقيقية إن لم يكن من ضمنهم، بدل عرض قائمة كاملة قد تضم مئات الأسماء */
    const buildItem = (res, rankNum)=>{
      const item = document.createElement('div');
      item.className = 'leaderboard-item';

      const rank = document.createElement('div');
      rank.className = 'leaderboard-rank';
      if(rankNum===1) rank.classList.add('first');
      else if(rankNum===2) rank.classList.add('second');
      else if(rankNum===3) rank.classList.add('third');
      rank.textContent = rankNum;

      const info = document.createElement('div');
      info.className = 'leaderboard-info';

      const name = document.createElement('div');
      name.className = 'leaderboard-name';
      name.textContent = (res.studentId === Student.id) ? `${res.name || res.studentName || 'طالب غير معروف'} (أنت)` : (res.name || res.studentName || 'طالب غير معروف');

      const score = document.createElement('div');
      score.className = 'leaderboard-score';
      let dateLabel = 'غير محدد';
      if(res.submittedAt){
        const d = (typeof res.submittedAt.toDate === 'function') ? res.submittedAt.toDate() : new Date(res.submittedAt);
        if(d && !isNaN(d.getTime())) dateLabel = d.toLocaleDateString('ar-EG');
      }
      const timeLabel = (typeof res.timeSeconds === 'number') ? ` — ⏱ ${formatDurationAr(res.timeSeconds)}` : '';
      score.textContent = `تاريخ: ${dateLabel}${timeLabel}`;

      info.appendChild(name);
      info.appendChild(score);

      const percent = document.createElement('div');
      percent.className = 'leaderboard-percent';
      percent.textContent = `${res.percent || 0}%`;

      item.appendChild(rank);
      item.appendChild(info);
      item.appendChild(percent);
      return item;
    };

    listDiv.innerHTML = '';
    top10.forEach((res, idx)=> listDiv.appendChild(buildItem(res, idx+1)));

    const myRank = cache.ranks ? cache.ranks[Student.id] : null;
    if(myRank && myRank > 10){
      /* قراءة خفيفة إضافية (مستند واحد فقط) لجلب تفاصيل نتيجة التلميذ نفسه */
      const mine = await Leaderboard.mine(lesson.id);
      const sep = document.createElement('div');
      sep.style.cssText = 'margin:10px 0;border-top:1px dashed #ccc;';
      listDiv.appendChild(sep);
      listDiv.appendChild(buildItem(Object.assign({ studentId:Student.id, name:Student.fullName }, mine||{}), myRank));
    } else if(!myRank && Student.id){
      const note = document.createElement('div');
      note.className = 'leaderboard-empty';
      note.style.padding = '10px 0';
      note.textContent = 'لم تُنجز هذا التمرين بعد.';
      listDiv.appendChild(note);
    }
  }catch(e){
    console.error('Error loading leaderboard:', e);
    listDiv.innerHTML = '<div class="leaderboard-empty">خطأ في تحميل النتائج</div>';
  }
}

/* =========================================================================================
   تحميل تمارين الدروس — كل الدروس تُجلب الآن من ملفات JSON خارجية (content/exercises/)
   ========================================================================================= */
const LESSON_EXERCISES = {
  /* لم يعد أي درس مُضمَّنًا مباشرة هنا (بما فيها 'badal' التي كانت مُضمَّنة سابقًا): كل تمارين
     الدروس تُجلب الآن من content/exercises/<lessonId>.json — يكفي إضافة/تعديل ملف JSON
     في content/exercises/<lessonId>.json دون لمس app.js إطلاقًا (انظر loadLessonExercise). */
};

async function loadLessonExercise(lessonId){
  /* أولًا: التمارين المضمّنة مباشرة في الكود (كما كانت). */
  if(LESSON_EXERCISES[lessonId]) return LESSON_EXERCISES[lessonId];
  /* ثانيًا (جديد): إن لم توجد مضمّنة، نجرّب جلبها تلقائيًا من content/exercises/<lessonId>.json
     — هذا يسمح لاحقًا بإضافة تمارين أي درس آخر برفع ملف JSON فقط، دون لمس app.js إطلاقًا. */
  try{
    const res = await fetch(`content/exercises/${lessonId}.json`, { cache:'no-store' });
    if(res.ok) return await res.json();
  }catch(e){ /* لا إنترنت أو الملف غير موجود بعد — نتجاهل بصمت */ }
  return null;
}

/* =========================================================================================
   محرك «اختبار الفهم» — محلي بالكامل، بلا Firebase، نسبة تراكمية من 100%
   إعادة الأسئلة الخاطئة فقط، التلميذ يقرر بنفسه متى يتوقف، لا يدخل أي ترتيب.
   ========================================================================================= */
function shuffleArr(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

function createQuizEngine(lesson, mountEl){
  const total = lesson.mcq.length;
  let order = shuffleArr(lesson.mcq.map((_,i)=>i));
  let correctSet = new Set();     // فهارس الأسئلة التي أُجيبت صحيحة (تراكميًا، لا تُعاد)
  let roundQueue = order.slice(); // أسئلة الجولة الحالية
  let idx = 0;
  const PASS_THRESHOLD = 80; // لا تُكشف الإجابات الصحيحة إلا بعد تجاوز هذه النسبة

  function currentPercent(){ return Math.round((correctSet.size/total)*100); }

  function renderQuestion(){
    if(idx >= roundQueue.length){
      renderResult();
      return;
    }
    const qIndex = roundQueue[idx];
    const item = lesson.mcq[qIndex];
    const opts = item.options.map((opt,oi)=>`<button class="mcq-btn" data-oi="${oi}">${opt}</button>`).join('');
    mountEl.innerHTML = `
      <div class="quiz-progress">سؤال ${idx+1} من ${roundQueue.length} — التقدّم التراكمي: <b>${currentPercent()}%</b></div>
      <div class="quiz-card">
        <div class="quiz-q">${item.q}</div>
        <div class="quiz-opts">${opts}</div>
        <div class="quiz-explain" style="display:none"></div>
        <button class="quiz-next-btn" style="display:none">التالي ←</button>
      </div>`;
    const btns = mountEl.querySelectorAll('.mcq-btn');
    btns.forEach(b=>{
      b.addEventListener('click', ()=>{
        btns.forEach(x=>x.disabled = true);
        const oi = parseInt(b.getAttribute('data-oi'));
        const ok = oi === item.correct;
        const ex = mountEl.querySelector('.quiz-explain');
        if(ok){
          if(window.SoundFX) SoundFX.correct();
          b.classList.add('correct'); correctSet.add(qIndex);
        } else {
          if(window.SoundFX) SoundFX.wrong();
          /* لا نكشف أي إجابة صحيحة أو تفسير هنا — فقط نُشير أن اختيار التلميذ كان خاطئًا،
             حتى لا تظهر له الإجابة الصحيحة قبل أن يتجاوز نسبة النجاح المطلوبة */
          b.classList.add('wrong');
          ex.innerHTML = '❌ إجابة غير صحيحة. تابع الأسئلة، وستظهر لك الإجابات الصحيحة كاملة بعد تجاوزك نسبة ' + PASS_THRESHOLD + '%.';
          ex.style.display = 'block';
        }
        mountEl.querySelector('.quiz-next-btn').style.display = 'inline-block';
      });
    });
    mountEl.querySelector('.quiz-next-btn').addEventListener('click', ()=>{ idx++; renderQuestion(); });
  }

  function renderResult(){
    const pct = currentPercent();
    const wrongCount = total - correctSet.size;
    const passed = pct >= PASS_THRESHOLD;
    recordQuizAchievement(lesson.id, pct, wrongCount === 0);
    let tier = 'retry', emoji='🌱', title='لا بأس، البداية دائمًا هكذا!',
        msg = 'كل خبير كان مبتدئًا يومًا. راجع الدرس وحاول مجددًا، أنا واثق أنك ستتحسّن بسرعة 💛';
    if(pct >= 90){ tier='excellent'; emoji='🏆'; title='أداء استثنائي يا نجم! 🌟'; msg='لقد أتقنت هذا الدرس بامتياز! واصل بنفس الحماس 🚀'; }
    else if(pct >= 60){ tier='good'; emoji='💪'; title='أحسنت، نتيجة جيدة جدًا!'; msg='أنت قريب جدًا من الإتقان الكامل. راجع الأخطاء البسيطة 🌱'; }

    mountEl.innerHTML = `
      <div class="result-card ${tier}">        <div class="result-emoji">${emoji}</div>
        <div class="result-gauge" style="--pct:${pct}"><div class="rg-pct">${pct}%</div></div>
        <div class="result-title">${title}</div>
        <div class="result-msg">${msg}</div>
      </div>
      <div style="text-align:center; margin-top:14px;">
        ${wrongCount === 0 ? `<button class="cert-download-btn" id="quizCertBtn" style="margin-bottom:12px">🎓 احصل على شهادة تقديرك</button><br>` : ''}
        ${wrongCount > 0
          ? `<button class="quiz-retry-btn">🔁 أعد الأسئلة الخاطئة فقط (${wrongCount})</button>
             <p style="font-size:11.5px;color:#5B6E62;margin-top:10px">أنت من يقرر: يمكنك التوقف الآن أو إعادة المحاولة لرفع نسبتك أكثر.</p>`
          : `<p style="font-weight:800;color:#3F6350">🎉 أجبتَ عن كل الأسئلة بشكل صحيح! أتممتَ هذا الاختبار بنسبة 100%.</p>`}
        ${passed ? `<button class="quiz-retry-btn" id="quizRevealBtn" style="margin-top:10px">📖 إظهار الإجابات الصحيحة والتفسير</button>` : ''}
      </div>
      <div id="quizReviewMount" style="margin-top:16px"></div>`;
    if(wrongCount === 0){
      document.getElementById('quizCertBtn').addEventListener('click', ()=>{
        openCertificateModal(lesson, pct);
      });
    }
    if(wrongCount > 0){
      mountEl.querySelector('.quiz-retry-btn').addEventListener('click', ()=>{
        roundQueue = order.filter(qi => !correctSet.has(qi));
        idx = 0;
        renderQuestion();
      });
    }
    if(passed){
      document.getElementById('quizRevealBtn').addEventListener('click', ()=>{
        const rev = document.getElementById('quizReviewMount');
        rev.innerHTML = order.map(qi=>{
          const item = lesson.mcq[qi];
          return `<div class="quiz-card" style="margin-bottom:10px">
            <div class="quiz-q">${item.q}</div>
            <div style="font-weight:800;color:#3F6350;margin:8px 0">✅ الإجابة الصحيحة: ${item.options[item.correct]}</div>
            <div class="quiz-explain" style="display:block">${item.explain||''}</div>
          </div>`;
        }).join('');
      });
    }
  }

  renderQuestion();
}

/* =========================================================================================
   محرك «إعراب الجمل» الشفهي (يُستخدم مع EXAM_FULL و EXAM_FULL2)
   ========================================================================================= */
const AR_STOPWORDS = new Set(['جمله','في','محل','ل','و','او','أو','هذا','هذه','ذلك','التي','الذي','لام','من']);
function extractCoreTerms(answerText){
  const plain = answerText.replace(/<[^>]+>/g,'');
  const norm = normalizeAr(plain);
  const seen = new Set();
  norm.split(' ').forEach(tok=>{ if(tok.length>=2 && !AR_STOPWORDS.has(tok)) seen.add(tok); });
  return Array.from(seen);
}
function gradeExamAnswer(transcript, item){
  const norm = normalizeAr(transcript);
  if(!norm) return false;
  const given = new Set(norm.split(' ').filter(Boolean));
  if(item.core.length === 0) return false;
  let hits = 0; item.core.forEach(t=>{ if(given.has(t)) hits++; });
  return (hits/item.core.length) >= 0.6;
}

function createIrabEngine(data, mountEl, titleText){
  data.forEach(item=>{ if(!item.core) item.core = extractCoreTerms(item.a); });
  let order = shuffleArr(data.map((_,i)=>i));
  let index = 0, score = 0, wrong = 0;
  const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;

  function render(){
    const item = data[order[index]];
    mountEl.innerHTML = `
      <div class="irab-progress">${titleText} — السؤال ${index+1} من ${data.length} &nbsp;|&nbsp; ✅ ${score} ❌ ${wrong}</div>
      <div class="exam-full-card">
        <div class="efc-tag">${item.tag}</div>
        <div class="efc-question">${item.q}</div>
        <div class="efc-heard" id="irabHeard"></div>
        <div class="efc-verdict" id="irabVerdict"></div>
        <div class="efc-answer" id="irabAnswer"><b>الإجابة الصحيحة:</b> ${item.a}</div>
      </div>
      <div class="exam-full-controls">
        ${SRClass ? `<button class="efc-mic-btn" id="irabMic">🎙️ سجّل إجابتك الآن</button>`
                  : `<div class="efc-no-mic show">⚠️ متصفحك لا يدعم التعرّف على الصوت. جرّب Chrome.</div>`}
        <div class="exam-full-nav"><button class="efc-next-btn" id="irabNext">السؤال التالي ←</button></div>
      </div>`;
    if(SRClass){
      document.getElementById('irabMic').addEventListener('click', ()=>{
        const micBtn = document.getElementById('irabMic');
        if(micBtn.classList.contains('recording')) return;
        const recognition = new SRClass();
        recognition.lang = 'ar-SA'; recognition.interimResults = false; recognition.maxAlternatives = 1;
        micBtn.classList.add('recording'); micBtn.textContent = '🔴 يستمع الآن...';
        recognition.onresult = (e)=>{
          const transcript = e.results[0][0].transcript;
          document.getElementById('irabHeard').textContent = `🗣️ سمعتُ: «${transcript}»`;
          document.getElementById('irabHeard').classList.add('show');
          const ok = gradeExamAnswer(transcript, item);
          if(window.SoundFX) (ok ? SoundFX.correct() : SoundFX.wrong());
          if(ok) score++; else { wrong++; document.getElementById('irabAnswer').classList.add('show'); }
          const v = document.getElementById('irabVerdict');
          v.classList.add('show', ok?'ok':'no'); v.textContent = ok ? '✅ إجابة صحيحة' : '❌ إجابة غير دقيقة';
          document.getElementById('irabNext').classList.add('show');
          micBtn.style.display = 'none';
        };
        recognition.onerror = ()=>{ micBtn.classList.remove('recording'); micBtn.textContent = '🎙️ سجّل إجابتك الآن'; };
        recognition.onend = ()=>{ micBtn.classList.remove('recording'); micBtn.textContent = '🎙️ سجّل إجابتك الآن'; };
        recognition.start();
      });
    }
    document.getElementById('irabNext').addEventListener('click', ()=>{
      if(index < data.length-1){ index++; render(); } else { renderFinal(); }
    });
  }
  function renderFinal(){
    const pct = Math.round((score/data.length)*100);
    mountEl.innerHTML = `
      <div class="result-card ${pct>=80?'excellent':pct>=50?'good':'retry'}">
        <div class="result-emoji">${pct>=80?'🏆':pct>=50?'💪':'🌱'}</div>
        <div class="result-gauge" style="--pct:${pct}"><div class="rg-pct">${pct}%</div></div>
        <div class="result-title">انتهى الاختبار!</div>
        <div class="result-msg">✅ ${score} صحيحة &nbsp;|&nbsp; ❌ ${wrong} خاطئة من أصل ${data.length}</div>
      </div>
      <div style="text-align:center;margin-top:14px">
        <button class="quiz-retry-btn" id="irabRestart">🔄 إعادة الاختبار</button>
      </div>`;
    document.getElementById('irabRestart').addEventListener('click', ()=>{
      order = shuffleArr(data.map((_,i)=>i)); index=0; score=0; wrong=0; render();
    });
  }
  render();
}

/* =========================================================================================
   التنقّل بين الشاشات وربط الواجهة (مبني على هيكل index.html)
   ========================================================================================= */
/* زر "🔑 دخول الأستاذ/المشرف" ظاهر دائمًا للجميع أعلى الصفحة؛ الحماية الفعلية تكون
   بالرمز السري (2580) عند فتح نافذة الدخول، سواء كان الجهاز قد استُعمل من قبل أم لا. */

const Screens = {
  el: {}, // يُملأ عند التحميل بعناصر id لكل شاشة

  init(){
    ['home','lessons','lessonDetail','exams','dailyExercises','irab','situation','leaderboard','chat','admin'].forEach(s=>{
      this.el[s] = document.getElementById('screen-'+s);
    });
    document.querySelectorAll('[data-nav]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const target = btn.getAttribute('data-nav');
        // "تمارين يومية" تفتح مباشرة تطبيق المعلّم الذكي (بدل عرض شاشة وسيطة فيها وصف فقط)
        if(target === 'dailyExercises'){ window.location.href = 'smart-teacher.html?cat=daily'; return; }
        this.show(target);
      });
    });
    document.getElementById('adminEntryBtn').addEventListener('click', ()=> this.openAdminLogin());
  },

  show(name){
    if(window.SoundFX) SoundFX.navigate();
    if(name !== 'situation' && typeof stopStoryNarration === 'function') stopStoryNarration();
    Object.values(this.el).forEach(e=>{ if(e) e.style.display = 'none'; });
    if(this.el[name]) this.el[name].style.display = 'block';
    window.scrollTo({top:0, behavior:'instant'});
    
    /* ========== التحكم في ظهور الترويسة والترحيب ========== */
    const hero = document.querySelector('.hero');
    const welcomeBox = document.getElementById('welcomeBox');
    
    if(name === 'home'){
      /* في الشاشة الرئيسية: أظهر الترويسة الكاملة والترحيب */
      if(hero) hero.style.display = 'block';
      if(welcomeBox) welcomeBox.style.display = Student.status === 'approved' ? 'flex' : 'none';
    } else {
      /* في التبويبات الأخرى (الدروس، الفروض، إعراب، الترتيب): أخفِ الترويسة وأظهر الترحيب فقط */
      if(hero) hero.style.display = 'none';
      if(welcomeBox) welcomeBox.style.display = Student.status === 'approved' ? 'flex' : 'none';
    }
    
    if(name === 'lessons') renderLessonsScreen();
    if(name === 'exams') renderExamsScreen();
    if(name === 'chat') renderChatScreen();
    if(name === 'irab') renderIrabScreen();
    if(name === 'situation') renderSituationScreen();
    if(name === 'leaderboard') renderLeaderboardScreen();
  },

  openAdminLogin(){
    const modal = document.getElementById('adminLoginModal');
    modal.classList.add('show');
  }
};

/* ---------- الشاشة الرئيسية: رسالة الترحيب ---------- */
function renderWelcome(){
  const box = document.getElementById('welcomeBox');
  if(!box) return;
  if(Student.status === 'approved' && Student.fullName){
    box.innerHTML = `
      <div class="wb-mascot-wrap">${MASCOT_SVG}</div>
      <div class="wb-text">
        <div class="wb-greet">مرحبًا بعودتك</div>
        <div class="wb-name">أهلًا، <b>${Student.fullName}</b> ✨</div>
      </div>
      <button class="back-btn" id="studentLogoutBtn" style="flex-shrink:0">🚪 خروج</button>`;
    box.style.display = 'flex';
    document.getElementById('studentLogoutBtn').addEventListener('click', ()=>{
      if(!confirm('هل تريد تسجيل الخروج من المنصة؟')) return;
      if(window.SoundFX) SoundFX.logout();
      Student.logout();
      location.reload();
    });
    renderBadges();
  } else {
    box.style.display = 'none';
  }
}

/* =========================================================================================
   شارات الإنجاز — مبنية على بيانات حقيقية (سلسلة الدخول من Firestore، بقية الشارات محليًا
   على جهاز التلميذ من نتائج اختبار الفهم)
   ========================================================================================= */
function getAchievements(){
  if(!Student.id) return { passed:[], perfect:false };
  return lsGet('achv_' + Student.id) || { passed:[], perfect:false };
}
function saveAchievements(a){
  if(!Student.id) return;
  lsSet('achv_' + Student.id, a);
}
/* تُستدعى من محرك اختبار الفهم عند كل نتيجة نهائية */
function recordQuizAchievement(lessonId, pct, isPerfect){
  if(!Student.id) return; // شارات الإنجاز تتطلب حسابًا مسجَّلًا لتُحفظ
  const a = getAchievements();
  if(pct >= 80 && !a.passed.includes(lessonId)) a.passed.push(lessonId);
  if(isPerfect) a.perfect = true;
  saveAchievements(a);
  renderBadges();
}

async function renderBadges(){
  if(Student.status !== 'approved' || !Student.id) return;
  const a = getAchievements();

  const streakEl = document.getElementById('badge-streak');
  if(streakEl){
    const active = Student.streak >= 1;
    streakEl.classList.toggle('active', active);
    let countEl = streakEl.querySelector('.st-count');
    if(active){
      if(!countEl){ countEl = document.createElement('div'); countEl.className = 'st-count'; streakEl.appendChild(countEl); }
      countEl.textContent = Student.streak;
    } else if(countEl){ countEl.remove(); }
  }
  const goalEl = document.getElementById('badge-goal');
  if(goalEl) goalEl.classList.toggle('active', a.passed.length >= 1);
  const fastEl = document.getElementById('badge-fast');
  if(fastEl) fastEl.classList.toggle('active', a.passed.length >= 3);
  const perfectEl = document.getElementById('badge-perfect');
  if(perfectEl) perfectEl.classList.toggle('active', !!a.perfect);
}

/* ---------- تصنيفات الدروس (كما تصنيف الفهرس) ---------- */
const CATEGORY_META = {
  taqweem:{ icon:'📋', title:'التقويم التشخيصي' },
  muktasabat:{ icon:'🧩', title:'المكتسبات القبلية' },
  tawabi: { icon:'📗', title:'التوابع' },
  qawaid: { icon:'📘', title:'قواعد اللغة' },
  jumal:  { icon:'📙', title:'الجمل التي لها محلّ من الإعراب' },
  balagha:{ icon:'📕', title:'الظواهر البلاغية' },
  anmat:  { icon:'📓', title:'أنماط النصوص' },
  itisaq: { icon:'📔', title:'الاتساق والانسجام' }
};

function renderLessonsScreen(){
  const wrap = document.getElementById('lessonsListWrap');
  wrap.innerHTML = '<div class="sf-label">جاري التحميل…</div>';
  Locks.load().then(()=>{
    /* الدروس المغلقة تُخفى بالكامل؛ يظهر فقط المفتوح أو ما بانتظار المحتوى (قريبًا) */
    const visible = window.LESSONS.filter(l=> l.locked==='pending' || !Locks.isLessonLocked(l.id));
    const openedAt = (Locks.data && Locks.data.openedAt) || {};

    /* قائمة واحدة مسطّحة بلا مجموعات: آخر درس فتحه الأستاذ في الأعلى.
       الدروس المفتوحة قبل هذا التحديث (بلا وقت فتح) تأتي بعد الأحدث، الأعلى ترتيبًا في المنهج أولًا.
       الدروس "قريبًا" في آخر القائمة. */
    const flat = visible.filter(l=> l.category!=='muktasabat').sort((a,b)=>{
      const pa = a.locked==='pending', pb = b.locked==='pending';
      if(pa !== pb) return pa ? 1 : -1;
      if(pa && pb) return a.order - b.order;
      const ta = openedAt[a.id] || 0, tb = openedAt[b.id] || 0;
      if(ta !== tb) return tb - ta;
      return b.order - a.order;
    });
    const muk = visible.filter(l=> l.category==='muktasabat').sort((a,b)=> a.order-b.order);

    /* شارة "جديد": لأحدث درس فتحه الأستاذ فقط، وتزول بعد 7 أيام */
    const newest = flat.find(l=> l.locked!=='pending' && openedAt[l.id]);
    const newId = (newest && Date.now() - openedAt[newest.id] < 7*24*3600*1000) ? newest.id : null;

    const rowHtml = (l, numHtml)=>{
      const pending = l.locked === 'pending';
      const locked = pending || Locks.isLessonLocked(l.id);
      const meta = CATEGORY_META[l.category] || {};
      const sub = pending ? 'قريبًا — بانتظار المحتوى' : (l.category==='muktasabat' ? (l.subtitle||'') : [meta.title, l.subtitle].filter(Boolean).join(' · '));
      return `<div class="lesson-row ${locked?'locked':''} ${pending?'placeholder':''}" data-lesson="${l.id}">
          <div class="lr-num"><span class="lr-num-text">${numHtml}</span></div>
          <div class="lr-text">
            <div class="lr-title">${l.title}${l.id===newId ? '<span class="lr-new-badge">جديد</span>' : ''}</div>
            <div class="lr-sub">${sub}</div>
          </div>
          <div class="lr-status">${pending ? '⏳' : (locked ? '🔒' : '✅')}</div>
        </div>`;
    };

    let html = '<div class="lesson-list">' + flat.map(l=> rowHtml(l, (CATEGORY_META[l.category]||{}).icon || '📘')).join('') + '</div>';

    /* المجموعة الوحيدة المتبقية: المكتسبات القبلية */
    if(muk.length){
      const meta = CATEGORY_META.muktasabat;
      const categoryId = 'category-muktasabat';
      html += `
        <div class="lesson-accordion">
          <div class="group-header accordion-toggle" data-category="${categoryId}">
            <span class="gh-icon"><span>${meta.icon}</span></span>
            <span class="gh-title">${meta.title}</span>
            <span class="gh-count">${muk.length} دروس</span>
            <span class="accordion-arrow" style="margin-right: auto; transition: transform 0.3s ease;">▶</span>
          </div>
          <div class="lesson-list accordion-content" id="${categoryId}" style="display: none; max-height: 0; overflow: hidden; transition: max-height 0.3s ease, opacity 0.3s ease; opacity: 0;">
            ${muk.map(l=> rowHtml(l, String(l.order).padStart(2,'0'))).join('')}
          </div>
        </div>`;
    }

    wrap.innerHTML = html;

    /* فتح/إغلاق مجموعة المكتسبات القبلية */
    wrap.querySelectorAll('.accordion-toggle').forEach(toggle=>{
      toggle.addEventListener('click', function(){
        const content = document.getElementById(this.getAttribute('data-category'));
        const arrow = this.querySelector('.accordion-arrow');
        if(content.style.display === 'none'){
          content.style.display = 'block';
          content.style.maxHeight = content.scrollHeight + 'px';
          setTimeout(() => content.style.opacity = '1', 10);
          arrow.textContent = '▼';
        } else {
          content.style.opacity = '0';
          content.style.maxHeight = '0';
          setTimeout(() => { if(content.style.maxHeight === '0px') content.style.display = 'none'; }, 300);
          arrow.textContent = '▶';
        }
      });
    });

    /* معالج النقر على الدروس */
    wrap.querySelectorAll('.lesson-row').forEach(row=>{
      row.addEventListener('click', ()=>{
        if(row.classList.contains('locked')) return;
        openLessonDetail(row.getAttribute('data-lesson'));
      });
    });
  });
}

function openLessonDetail(id){
  const lesson = window.LESSONS.find(l=>l.id===id);
  if(!lesson) return;
  const zoomOnly = !!lesson.zoomOnly;
  /* سلسلة "المكتسبات القبلية" (BEM2024): 11 حلقة بلا تمارين ولا تسجيلات زوم حقيقية —
     تُخفى لهذه الفئة تحديدًا بطاقة "ترتيب تلاميذ هذا الدرس" وصندوق "تسجيلات حصص الزوم" */
  const isMuktasabat = lesson.category === 'muktasabat';

  Screens.show('lessonDetail');
  document.getElementById('ldTitle').textContent = lesson.title;
  document.getElementById('ldSubtitle').textContent = lesson.subtitle||'';

  /* تلوين الدائرة حسب وحدة الدرس (كل وحدة لها لونها الخاص لتمييزها بسرعة) */
  const ldBadge = document.getElementById('ldBadge');
  if(ldBadge) ldBadge.className = 'badge cat-' + (lesson.category || 'taqweem');

  /* بطاقة عرض الترتيب (أيقونة كأس بتصميم عربي + عنوان صغير واضح) — آخر عنصر في صفحة الدرس،
     غير مجدية لدرس بلا تمارين (zoomOnly) أو لسلسلة المكتسبات القبلية (بلا تمارين) فتُخفى في هذه الحالة */
  let leaderSection = document.getElementById('ldLeaderboardSection');
  if(leaderSection && !leaderSection.querySelector('.ld-leaderboard-card')){
    leaderSection.innerHTML = `
      <div class="ld-leaderboard-card" id="ldLeaderboardBtn">
        <div class="ld-leaderboard-icon"><span class="icon-glyph">🏆</span></div>
        <div class="ld-leaderboard-title">ترتيب تلاميذ هذا الدرس</div>
      </div>`;
  }
  const leaderBtn = document.getElementById('ldLeaderboardBtn');
  if(leaderSection) leaderSection.style.display = (zoomOnly || isMuktasabat) ? 'none' : '';
  if(leaderBtn) leaderBtn.onclick = ()=>{ if(window.SoundFX) SoundFX.click(); showLeaderboardPopup(lesson); };

  /* درس "بلا محتوى" (zoomOnly): يُعرض فقط العنوان + تسجيلات حصص الزوم، وتُخفى بقية الأقسام
     (الشرح، الخريطة الذهنية، اختبار الفهم، تمارين الدرس) بدل تركها فارغة على الشاشة */
  const ldDef = document.getElementById('ldDef');

  ldDef.style.display = zoomOnly ? 'none' : '';
  ldDef.innerHTML = lesson.def||'';

  const videos = Array.isArray(lesson.video) ? lesson.video : (lesson.video ? [lesson.video] : []);
  const videoFrame = document.getElementById('ldVideo');
  const listenWrap = videoFrame.closest('.listen-wrap');
  if(!zoomOnly && videos.length && videos[0] && videos[0].yt){
    videoFrame.src = `https://www.youtube.com/embed/${videos[0].yt}?rel=0`;
    if(listenWrap) listenWrap.style.display = '';
  } else {
    videoFrame.src = '';
    if(listenWrap) listenWrap.style.display = 'none';
  }

  if(!zoomOnly){
    renderMindmap(lesson, document.getElementById('ldMindmap'));
    document.getElementById('ldMindmapPdfBtn').onclick = ()=> exportMindmapPDF(lesson);
  }

  window.currentOpenLessonId = lesson.id;
  const zoomBox = document.getElementById('ldZoomBox');
  const showZoom = !isMuktasabat;
  if(!showZoom){
    if(zoomBox) zoomBox.innerHTML = '';
  } else {
    renderZoomGroupsBox(lesson);
  }

  if(!zoomOnly){
    const quizMount = document.getElementById('ldQuiz');
    document.getElementById('ldQuizStartBtn').onclick = ()=>{
      document.getElementById('ldQuizStartBtn').style.display='none';
      createQuizEngine(lesson, quizMount);
    };
    quizMount.innerHTML = '';
    document.getElementById('ldQuizStartBtn').style.display='inline-block';

    renderLessonExercisesBox(lesson);
  }

  /* نوافذ (تبويبات) صفحة الدرس: تُبنى فقط من الأقسام الفعلية لهذا الدرس — درس zoomOnly
     يعرض تسجيلات الزوم فقط بلا تبويبات (قسم وحيد)، ودروس المكتسبات القبلية بلا تبويب زوم.
     التبويب الافتراضي المفتوح هو "تمارين الدرس" لأنه الأولوية (أكبر عدد من التلاميذ لا يُنجزونه). */
  const allTabs = [
    { key:'exercises', icon:'📝', title:'تمارين الدرس',   sub:'الواجب المنزلي',   cls:'c1', el:'ldExercisesSection', show: !zoomOnly },
    { key:'zoom',      icon:'🎥', title:'حصص الزوم',      sub:'والواجب المنزلي',  cls:'c2', el:'ldZoomSection',      show: showZoom },
    { key:'quiz',      icon:'🧠', title:'اختبار الفهم',   sub:'اختبر نفسك',       cls:'c3', el:'ldQuizSection',      show: !zoomOnly },
    { key:'mindmap',   icon:'🗺️', title:'الخريطة الذهنية', sub:'لخّص الدرس',       cls:'c4', el:'ldMindmapSection',   show: !zoomOnly }
  ];
  setupLdTabs(allTabs.filter(t=>t.show), 'exercises');
}

/* يبني شريط التبويبات أعلى صفحة الدرس ويربط النقر بإظهار/إخفاء النافذة المطابقة فقط.
   panels: مصفوفة {key,label,el} للأقسام المتاحة فعليًا لهذا الدرس (قسم واحد فقط = بلا تبويبات،
   تُعرض نافذته مباشرة). defaultKey: مفتاح التبويب المفتوح افتراضيًا عند دخول الدرس. */
function setupLdTabs(panels, defaultKey){
  const tabsBar = document.getElementById('ldTabs');
  if(!tabsBar) return;

  /* إخفاء كل النوافذ غير المتاحة لهذا الدرس بشكل نهائي (ليست مجرد تبويب غير نشط) */
  document.querySelectorAll('.ld-tab-panel').forEach(el=>{
    const inPanels = panels.some(p=>p.el===el.id);
    el.style.display = inPanels ? '' : 'none';
  });

  if(panels.length <= 1){
    tabsBar.style.display = 'none';
    tabsBar.innerHTML = '';
    return;
  }

  const activeKey = panels.some(p=>p.key===defaultKey) ? defaultKey : panels[0].key;
  tabsBar.style.display = '';
  tabsBar.innerHTML = panels.map(p=>
    `<div class="home-card ld-tab-card ${p.cls||'c1'} ${p.key===activeKey?'active':''}" role="button" tabindex="0" data-ld-tab="${p.key}">
      <div class="hc-icon-wrap">${p.icon||''}</div><div class="hc-title">${p.title}</div><div class="hc-sub">${p.sub||''}</div>
    </div>`
  ).join('');

  function activate(key){
    panels.forEach(p=>{
      const el = document.getElementById(p.el);
      if(el) el.style.display = (p.key===key) ? '' : 'none';
    });
    tabsBar.querySelectorAll('.ld-tab-card').forEach(btn=>{
      btn.classList.toggle('active', btn.getAttribute('data-ld-tab')===key);
    });
  }

  tabsBar.querySelectorAll('.ld-tab-card').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      activate(btn.getAttribute('data-ld-tab'));
    });
  });

  activate(activeKey);
}

/* =========================================================================================
   صندوق "تسجيلات حصص الزوم" — 4 تبويبات (الأفواج) تحت قسم الشرح في صفحة الدرس
   يجلب الرابط المخزَّن من طرف الأستاذ (ZoomLinks) ويشغّله داخل مشغل فيديو مدمج بالواجهة،
   بلا أي خروج لتطبيق خارجي وبلا أي تعديل على الكود عند إضافة دروس جديدة مستقبلاً.
   ========================================================================================= */

/* يحوّل رابط تيليجرام عادي (https://t.me/...) إلى صيغة tg:// الخاصة بالتطبيق، حتى يفتحه
   المتصفح مباشرة في تطبيق تيليجرام المثبّت (سطح المكتب أو الهاتف) بدل صفحة الويب web.telegram.org.
   يغطي: قناة/مجموعة خاصة (t.me/c/CHANNEL_ID/MSG_ID)، رابط دعوة (t.me/joinchat/HASH أو t.me/+HASH)،
   ومنشور/قناة عامة (t.me/username أو t.me/username/MSG_ID). إن لم يتعرّف على الصيغة يُعيد الرابط
   الأصلي كما هو (المتصفح سيفتحه في نسخة الويب كما كان سابقًا، دون أي ضرر). */
function toTelegramAppLink(url){
  const clean = (url||'').trim();
  let m = clean.match(/t(?:elegram)?\.me\/c\/(\d+)\/(\d+)/i);
  if(m) return `tg://privatepost?channel=${m[1]}&post=${m[2]}`;
  m = clean.match(/t(?:elegram)?\.me\/(?:joinchat\/|\+)([\w-]+)/i);
  if(m) return `tg://join?invite=${m[1]}`;
  m = clean.match(/t(?:elegram)?\.me\/([\w]+)\/(\d+)/i);
  if(m) return `tg://resolve?domain=${m[1]}&post=${m[2]}`;
  m = clean.match(/t(?:elegram)?\.me\/([\w]+)/i);
  if(m) return `tg://resolve?domain=${m[1]}`;
  return clean;
}

/* يبني HTML مشغّل الفيديو المناسب حسب نوع الرابط (يوتيوب، درايف، تيليجرام، ملف مباشر، أو أي رابط آخر) */
function buildZoomEmbedHTML(url){
  const clean = (url||'').trim();
  if(!clean) return '';

  /* يوتيوب */
  let m = clean.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/i);
  if(m) return `<iframe src="https://www.youtube.com/embed/${m[1]}?rel=0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;

  /* فيميو */
  m = clean.match(/vimeo\.com\/(\d+)/i);
  if(m) return `<iframe src="https://player.vimeo.com/video/${m[1]}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;

  /* Google Drive */
  m = clean.match(/drive\.google\.com\/file\/d\/([\w-]+)/i);
  if(m) return `<iframe src="https://drive.google.com/file/d/${m[1]}/preview" allow="autoplay" allowfullscreen loading="lazy"></iframe>`;

  /* تيليجرام (t.me / telegram.me) — روابط القنوات الخاصة بصيغة t.me/c/CHANNEL_ID/MSG_ID لا يمكن
     تضمينها داخل iframe إطلاقًا (تيليجرام يمنع ذلك، ويشترط أن يكون المشاهد نفسه عضوًا مسجّلاً
     دخوله في تيليجرام أصلاً). لذلك نعرض بطاقة أنيقة بزر فتح مباشر بدل إطار سيبقى فارغًا/معطوبًا.
     الزر الرئيسي يستعمل رابط tg:// (بروتوكول التطبيق نفسه) بدل https:// حتى يتوجّه المتصفح
     مباشرة لتطبيق تيليجرام المثبّت على الحاسوب (نفس سلوك الهاتف)، مع رابط احتياطي صغير
     بصيغة https:// لمن ليس لديه التطبيق مثبّتًا أو رفض المتصفح فتحه. */
  if(/(?:^|\/\/)(?:www\.)?(?:t|telegram)\.me\//i.test(clean)){
    const appLink = toTelegramAppLink(clean);
    return `<div class="zoom-telegram-box">
      <div class="zoom-telegram-icon"><span class="icon-glyph">📨</span></div>
      <a class="zoom-telegram-btn" href="${escZoomText(appLink)}">▶️ فتح الحصة في تطبيق تيليجرام</a>
      <a class="zoom-fallback-link" href="${escZoomText(clean)}" target="_blank" rel="noopener">لا يعمل الزر؟ افتح عبر المتصفح ⬈</a>
    </div>`;
  }

  /* ملف فيديو مباشر (mp4/webm/ogg/mov/m3u8...) */
  if(/\.(mp4|webm|ogg|mov|m3u8)(\?.*)?$/i.test(clean)){
    return `<video controls playsinline preload="metadata" src="${escZoomText(clean)}"></video>`;
  }

  /* أي رابط آخر (مثل رابط تسجيل زوم السحابي) — تضمين عام داخل الواجهة مع رابط احتياطي للفتح
     في نافذة جديدة إن رفض المصدر نفسه الفتح داخل إطار (X-Frame-Options) خارج عن إرادة المنصة */
  return `<iframe src="${escZoomText(clean)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    <a class="zoom-fallback-link" href="${escZoomText(clean)}" target="_blank" rel="noopener">فتح الفيديو في نافذة جديدة ⬈</a>`;
}


/* يبني خصائص رابط زر الوثيقة (ملخّص/تمارين): إن كان الرابط تيليجرام يستعمل صيغة tg:// ليفتح
   مباشرة في التطبيق المثبّت (بنفس منطق زر الفيديو)، وإلا يُفتح كالمعتاد في نافذة جديدة */
function buildZoomDocLinkAttrs(url){
  const isTg = /(?:^|\/\/)(?:www\.)?(?:t|telegram)\.me\//i.test((url||'').trim());
  const href = isTg ? toTelegramAppLink(url) : url;
  const targetAttrs = isTg ? '' : ' target="_blank" rel="noopener"';
  return `href="${escZoomText(href)}"${targetAttrs}`;
}

function renderZoomGroupsBox(lesson){
  const box = document.getElementById('ldZoomBox');
  if(!box) return;

  const links = ZoomLinks.getLinks(lesson.id);

  const tabsHtml = ZOOM_GROUPS.map((g,i)=>
    `<button type="button" class="zoom-tab-btn" data-zoom-tab="${g.key}">${g.label}</button>`
  ).join('');

  box.innerHTML = `
    <div class="zoom-groups-title">🎥 تسجيلات حصص الزوم</div>
    <div class="zoom-tabs">${tabsHtml}</div>
    <div class="zoom-player-box" id="zoomPlayerBox" style="display:none"></div>
    <div class="zoom-note">ملاحظة: لن تتمكن من مشاهدة الحصة إلا إذا كنت منضماً ومقبولاً مسبقاً في مخزن الفوج الخاص بك من طرف الأستاذ.</div>`;

  const playerBox = box.querySelector('#zoomPlayerBox');
  const tabBtns = Array.from(box.querySelectorAll('[data-zoom-tab]'));

  tabBtns.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const key = btn.getAttribute('data-zoom-tab');
      tabBtns.forEach(b=> b.classList.toggle('active', b===btn));
      const g = links[key];
      const groupLabel = ZOOM_GROUPS.find(x=> x.key===key).label;
      playerBox.style.display = '';

      /* أزرار وثائق هذا الفوج تحديدًا (ملخّص + تمارين) — تظهر فقط إن أضاف الأستاذ روابطها،
         وتُخفى تمامًا إن لم يُضِف شيئًا. كل رابط إضافي (إن وُجد أكثر من رابط لنفس النوع) يظهر
         بزر مستقل مرقّم حتى يميّز التلميذ بينها */
      const docsHtml = ZOOM_DOCS
        .map(d=> g[d.key].map((url,idx)=>
          `<a class="zoom-doc-btn" ${buildZoomDocLinkAttrs(url)}>${d.icon} ${d.btnLabel}${g[d.key].length>1?' '+(idx+1):''}</a>`
        ).join(''))
        .join('');
      const docsRow = docsHtml ? `<div class="zoom-docs-row">${docsHtml}</div>` : '';

      let videoHtml;
      if(!g.video.length){
        videoHtml = `<div class="zoom-empty-msg">⏳ لم يُضِف الأستاذ بعد تسجيل حصة هذا الفوج — حاول لاحقًا.</div>`;
      } else if(g.video.length === 1){
        videoHtml = buildZoomEmbedHTML(g.video[0]);
      } else {
        /* أكثر من رابط فيديو لهذا الفوج (مثلاً أكثر من حصة) — أزرار تبديل أعلى المشغّل،
           الفيديو الأول معروض افتراضيًا */
        const videoTabsHtml = g.video.map((url,idx)=>
          `<button type="button" class="zoom-video-tab-btn${idx===0?' active':''}" data-zoom-video-idx="${idx}">🎥 فيديو ${idx+1}</button>`
        ).join('');
        videoHtml = `<div class="zoom-video-tabs">${videoTabsHtml}</div><div class="zoom-video-embed">${buildZoomEmbedHTML(g.video[0])}</div>`;
      }

      /* الترتيب المطلوب: الفيديو أولاً، ثم وثائق الدرس (ملخّص/تمارين)، وأخيرًا إرفاق حل التمرين —
         وزر إرسال الحل لا يظهر إطلاقًا إلا إذا أضاف الأستاذ رابط تمرين لهذا الفوج تحديدًا */
      const hasExercise = g.exercises.length > 0;
      playerBox.innerHTML = videoHtml + docsRow + buildSolutionInlineHtml(hasExercise);

      if(g.video.length > 1){
        const videoTabBtns = Array.from(playerBox.querySelectorAll('[data-zoom-video-idx]'));
        const embedBox = playerBox.querySelector('.zoom-video-embed');
        videoTabBtns.forEach(vbtn=>{
          vbtn.addEventListener('click', ()=>{
            if(window.SoundFX) SoundFX.click();
            videoTabBtns.forEach(b=> b.classList.toggle('active', b===vbtn));
            const idx = parseInt(vbtn.getAttribute('data-zoom-video-idx'), 10);
            embedBox.innerHTML = buildZoomEmbedHTML(g.video[idx]);
          });
        });
      }

      wireSolutionInline(playerBox, lesson, key, groupLabel);
    });
  });
}

/* =========================================================================================
   إرسال حل التمرين (صورة/ملف) إلى الأستاذ عبر بوت تيليجرام — يظهر مباشرة تحت تسجيل/وثائق
   الفوج الذي اختاره التلميذ، فالفوج معروف تلقائيًا من التبويب المفتوح دون أي اختيار إضافي.
   يرفق تلقائيًا اسم التلميذ ولقبه ورقم هاتفه المسجَّل به وفوجه، حتى يعرف الأستاذ فورًا صاحب
   الحل عند استلامه في تيليجرام دون أي بحث يدوي.
   ========================================================================================= */
const SolutionSubmit = {
  async send(lesson, groupLabel, file){
    if(!TELEGRAM_CONFIG || !TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId){
      return { ok:false, reason:'not-configured' };
    }
    const caption =
      `📥 حل واجب منزلي جديد\n` +
      `👤 الاسم: ${Student.fullName || '—'}\n` +
      `📞 الهاتف: ${Student.phone || '—'}\n` +
      `👥 الفوج: ${groupLabel}\n` +
      `📘 الدرس: ${lesson.title}`;

    const isImage = /^image\//.test(file.type);
    const endpoint  = isImage ? 'sendPhoto' : 'sendDocument';
    const fieldName = isImage ? 'photo' : 'document';

    const form = new FormData();
    form.append('chat_id', TELEGRAM_CONFIG.chatId);
    form.append('caption', caption);
    form.append(fieldName, file, file.name || 'solution.jpg');

    try{
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/${endpoint}`, { method:'POST', body:form });
      const data = await res.json();
      if(data && data.ok) return { ok:true };
      console.error('فشل إرسال حل التمرين إلى تيليجرام (رد البوت):', data);
      return { ok:false, reason:'telegram-error' };
    }catch(e){
      console.error('تعذّر الاتصال بخادم تيليجرام لإرسال حل التمرين:', e);
      return { ok:false, reason:'network' };
    }
  }
};

/* عنصر مصغّر بلا أي شرح: حقل ملف + زر إرسال فقط — لا يظهر إطلاقًا لتلميذ غير مسجَّل دخوله،
   ولا يظهر أيضًا إن لم يكن الأستاذ قد أضاف تمرينًا لهذا الفوج (hasExercise=false) */
function buildSolutionInlineHtml(hasExercise){
  if(!Student.id || !Student.fullName) return '';
  if(!hasExercise) return '';
  return `
    <div class="solution-inline-row">
      <input type="file" id="solutionFileInput" accept="image/*,.pdf" class="solution-inline-file">
      <button type="button" class="zoom-doc-btn" id="solutionSendBtn">📨 إرسال حل الواجب المنزلي</button>
    </div>
    <div class="solution-file-preview" id="solutionFilePreview" style="display:none"></div>
    <div class="zoom-save-feedback" id="solutionSendFeedback"></div>`;
}

function wireSolutionInline(playerBox, lesson, groupKey, groupLabel){
  const fileInput = playerBox.querySelector('#solutionFileInput');
  const sendBtn = playerBox.querySelector('#solutionSendBtn');
  if(!fileInput || !sendBtn) return;

  const preview = playerBox.querySelector('#solutionFilePreview');
  fileInput.addEventListener('change', ()=>{
    const file = fileInput.files[0];
    if(!file){ preview.style.display = 'none'; preview.innerHTML = ''; return; }
    if(/^image\//.test(file.type)){
      preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="معاينة الحل">`;
    } else {
      preview.innerHTML = `<div class="solution-file-name">📄 ${escZoomText(file.name)}</div>`;
    }
    preview.style.display = 'block';
  });

  sendBtn.addEventListener('click', async ()=>{
    const feedback = playerBox.querySelector('#solutionSendFeedback');
    const file = fileInput.files[0];
    if(!file){
      feedback.textContent = '⚠️ الرجاء اختيار صورة أو ملف الحل أولاً.'; feedback.style.color = '#b5432a'; return;
    }

    sendBtn.disabled = true; sendBtn.textContent = '⏳ جاري الإرسال…';
    const res = await SolutionSubmit.send(lesson, groupLabel, file);

    if(res.ok){
      if(window.SoundFX) SoundFX.correct();
      feedback.textContent = '✅ تم إرسال حلّك إلى الأستاذ بنجاح.';
      feedback.style.color = 'var(--sage-deep,#3F6350)';
      fileInput.value = ''; preview.style.display = 'none'; preview.innerHTML = '';
      ZoomSolutions.log(lesson, groupKey, groupLabel); /* تسجيل إحصائي منفصل تمامًا عن إرسال تيليجرام — لعرضه في لوحة الأستاذ */
    } else if(res.reason === 'not-configured'){
      feedback.textContent = '⚠️ إرسال الحلول غير مُفعّل بعد من طرف الأستاذ. حاول لاحقًا.';
      feedback.style.color = '#b5432a';
    } else {
      feedback.textContent = '⚠️ تعذّر إرسال الحل، تحقق من اتصالك بالإنترنت وأعد المحاولة.';
      feedback.style.color = '#b5432a';
    }
    sendBtn.disabled = false; sendBtn.textContent = '📨 إرسال حل الواجب المنزلي';
  });
}

/* =========================================================================================
   إرسال حل الفرض/الاختبار (صورة/ملف) إلى الأستاذ عبر بوت تيليجرام — نفس آلية إرسال حل
   الواجب المنزلي بالضبط، لكنها تظهر في شاشة "الفروض والاختبارات" أسفل روابط الفصل المختار،
   ومرتبطة بالفصل (t1/t2/t3) بدل الدرس/الفوج. يُرفق تلقائيًا اسم التلميذ ورقم هاتفه والفصل،
   حتى يعرف الأستاذ فورًا صاحب الحل عند استلامه في تيليجرام دون أي بحث يدوي.
   ========================================================================================= */
const ExamSolutionSubmit = {
  async send(trimesterLabel, file){
    if(!TELEGRAM_CONFIG || !TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId){
      return { ok:false, reason:'not-configured' };
    }
    const caption =
      `📥 حل فرض/اختبار جديد\n` +
      `👤 الاسم: ${Student.fullName || '—'}\n` +
      `📞 الهاتف: ${Student.phone || '—'}\n` +
      `📚 الفصل: ${trimesterLabel}`;

    const isImage = /^image\//.test(file.type);
    const endpoint  = isImage ? 'sendPhoto' : 'sendDocument';
    const fieldName = isImage ? 'photo' : 'document';

    const form = new FormData();
    form.append('chat_id', TELEGRAM_CONFIG.chatId);
    form.append('caption', caption);
    form.append(fieldName, file, file.name || 'solution.jpg');

    try{
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/${endpoint}`, { method:'POST', body:form });
      const data = await res.json();
      if(data && data.ok) return { ok:true };
      console.error('فشل إرسال حل الفرض/الاختبار إلى تيليجرام (رد البوت):', data);
      return { ok:false, reason:'telegram-error' };
    }catch(e){
      console.error('تعذّر الاتصال بخادم تيليجرام لإرسال حل الفرض/الاختبار:', e);
      return { ok:false, reason:'network' };
    }
  }
};

/* عنصر مصغّر بلا أي شرح: حقل ملف + زر إرسال فقط — لا يظهر إطلاقًا لتلميذ غير مسجَّل دخوله،
   ولا يظهر أيضًا إن لم يكن الأستاذ قد أضاف أي فرض/اختبار لهذا الفصل (hasItems=false) */
function buildExamSolutionInlineHtml(hasItems){
  if(!Student.id || !Student.fullName) return '';
  if(!hasItems) return '';
  return `
    <div class="solution-inline-row">
      <input type="file" id="examSolutionFileInput" accept="image/*,.pdf" class="solution-inline-file">
      <button type="button" class="zoom-doc-btn" id="examSolutionSendBtn">📨 إرسال حل الفرض/الاختبار</button>
    </div>
    <div class="solution-file-preview" id="examSolutionFilePreview" style="display:none"></div>
    <div class="zoom-save-feedback" id="examSolutionSendFeedback"></div>`;
}

function wireExamSolutionInline(panel, trimesterKey, trimesterLabel){
  const fileInput = panel.querySelector('#examSolutionFileInput');
  const sendBtn = panel.querySelector('#examSolutionSendBtn');
  if(!fileInput || !sendBtn) return;

  const preview = panel.querySelector('#examSolutionFilePreview');
  fileInput.addEventListener('change', ()=>{
    const file = fileInput.files[0];
    if(!file){ preview.style.display = 'none'; preview.innerHTML = ''; return; }
    if(/^image\//.test(file.type)){
      preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="معاينة الحل">`;
    } else {
      preview.innerHTML = `<div class="solution-file-name">📄 ${escZoomText(file.name)}</div>`;
    }
    preview.style.display = 'block';
  });

  sendBtn.addEventListener('click', async ()=>{
    const feedback = panel.querySelector('#examSolutionSendFeedback');
    const file = fileInput.files[0];
    if(!file){
      feedback.textContent = '⚠️ الرجاء اختيار صورة أو ملف الحل أولاً.'; feedback.style.color = '#b5432a'; return;
    }

    sendBtn.disabled = true; sendBtn.textContent = '⏳ جاري الإرسال…';
    const res = await ExamSolutionSubmit.send(trimesterLabel, file);

    if(res.ok){
      if(window.SoundFX) SoundFX.correct();
      feedback.textContent = '✅ تم إرسال حلّك إلى الأستاذ بنجاح.';
      feedback.style.color = 'var(--sage-deep,#3F6350)';
      fileInput.value = ''; preview.style.display = 'none'; preview.innerHTML = '';
      ExamSolutions.log(trimesterKey, trimesterLabel); /* تسجيل إحصائي منفصل تمامًا عن إرسال تيليجرام — لعرضه في لوحة الأستاذ */
    } else if(res.reason === 'not-configured'){
      feedback.textContent = '⚠️ إرسال الحلول غير مُفعّل بعد من طرف الأستاذ. حاول لاحقًا.';
      feedback.style.color = '#b5432a';
    } else {
      feedback.textContent = '⚠️ تعذّر إرسال الحل، تحقق من اتصالك بالإنترنت وأعد المحاولة.';
      feedback.style.color = '#b5432a';
    }
    sendBtn.disabled = false; sendBtn.textContent = '📨 إرسال حل الفرض/الاختبار';
  });
}

/* =========================================================================================
   سجلّ إحصائي لحلول الفروض والاختبارات — مستقل تمامًا عن إرسال تيليجرام (الذي يبقى كما هو).
   يُسجَّل هنا فقط: الفصل، اسم التلميذ ومعرّفه — بلا أي ملف/صورة (تبقى في تيليجرام حصريًا).
   الهدف: تمكين الأستاذ من رؤية "من أرسل ومن لم يرسل" مباشرة من داخل المنصة.
   ========================================================================================= */
const ExamSolutions = {
  /* وثيقة واحدة لكل (فصل + تلميذ) — إعادة إرسال نفس التلميذ لنفس الفصل تُحدّث الوثيقة بدل تكرارها */
  async log(trimesterKey, trimesterLabel){
    if(!fbReady || !Student.id) return;
    try{
      await db.collection('examSolutions').doc(`${trimesterKey}_${Student.id}`).set({
        trimesterKey, trimesterLabel,
        studentId: Student.id,
        studentName: Student.fullName,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }catch(e){ console.error('تعذّر تسجيل إحصائية حل الفرض/الاختبار:', e); }
  },

  /* كل السجلات مجمّعة حسب الفصل — لعرضها في نافذة "حلول التلاميذ للفروض والاختبارات" */
  async allGrouped(){
    if(!fbReady) return [];
    const snap = await db.collection('examSolutions').get();
    const byTrimester = new Map(); // trimesterKey -> { trimesterLabel, names:[] }
    snap.forEach(doc=>{
      const d = doc.data();
      if(!byTrimester.has(d.trimesterKey)) byTrimester.set(d.trimesterKey, { trimesterLabel:d.trimesterLabel, names:[] });
      byTrimester.get(d.trimesterKey).names.push(d.studentName);
    });
    const order = new Map([['t1',0],['t2',1],['t3',2]]);
    return Array.from(byTrimester.entries())
      .map(([trimesterKey, v])=> ({ trimesterKey, trimesterLabel:v.trimesterLabel, names:v.names }))
      .sort((a,b)=> (order.get(a.trimesterKey) ?? 999) - (order.get(b.trimesterKey) ?? 999));
  }
};

/* نافذة "حلول التلاميذ للفروض والاختبارات" من لوحة الأستاذ — زر فتح تيليجرام أعلى النافذة،
   وتحتها إحصائيات من أرسل حلاً (الفصل، عدد التلاميذ وأسماؤهم) */
function openExamSolutionsModal(){
  const overlay = document.createElement('div');
  overlay.className = 'zoom-modal-overlay';
  const telegramBtnHtml = (TELEGRAM_CONFIG && TELEGRAM_CONFIG.groupInviteLink)
    ? `<a class="zoom-telegram-btn" style="display:block;text-align:center;text-decoration:none;margin-bottom:18px" href="${TELEGRAM_CONFIG.groupInviteLink}" target="_blank" rel="noopener">▶️ فتح مجموعة الحلول على تيليجرام</a>`
    : `<div class="lesson-cta-note">رابط دعوة المجموعة غير مضبوط في telegram-config.js</div>`;
  overlay.innerHTML = `
    <div class="zoom-modal-popup">
      <div class="zoom-modal-header">
        <div class="zoom-modal-title">📨 حلول التلاميذ للفروض والاختبارات</div>
        <div class="zoom-modal-subtitle">افتح المحادثة لمشاهدة الملفات، أو تصفّح من أرسل حلاً لكل فصل</div>
        <button type="button" class="zoom-modal-close" id="examSolutionsModalCloseBtn">✕</button>
      </div>
      <div class="zoom-modal-body" id="examSolutionsModalBody">
        ${telegramBtnHtml}
        <div id="examSolutionsStatsMount"><div class="sf-label">جاري تحميل الإحصائيات…</div></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.remove(); });
  overlay.querySelector('#examSolutionsModalCloseBtn').addEventListener('click', ()=> overlay.remove());

  renderExamSolutionsStats(overlay);
}

async function renderExamSolutionsStats(overlay){
  const mount = overlay.querySelector('#examSolutionsStatsMount');
  if(!fbReady){
    mount.innerHTML = '<div class="lesson-cta-note">Firebase غير مفعّل — لا يمكن عرض الإحصائيات.</div>';
    return;
  }
  let data;
  try{
    data = await ExamSolutions.allGrouped();
  }catch(e){
    mount.innerHTML = '<div class="lesson-cta-note">تعذّر تحميل الإحصائيات، تحقّق من قواعد أمان Firestore لمجموعة examSolutions.</div>';
    return;
  }
  const withSubmissions = data.filter(t=> t.names.length>0);
  if(!withSubmissions.length){
    mount.innerHTML = '<div class="lesson-cta-note">لم يُرسل أي تلميذ حلاً بعد.</div>';
    return;
  }
  renderExamSolutionsTrimestersList(overlay, withSubmissions);
}

/* المستوى الأول: قائمة الفصول — لا يظهر الفصل هنا إلا بعد وصول أول حل له من أي تلميذ */
function renderExamSolutionsTrimestersList(overlay, data){
  const mount = overlay.querySelector('#examSolutionsStatsMount');
  const rows = data.map(t=> `
    <div class="lesson-row zoom-lesson-row" data-exam-solutions-trimester="${escZoomText(t.trimesterKey)}">
      <div class="lr-text"><div class="lr-title">📚 ${escZoomText(t.trimesterLabel)}</div></div>
      <div class="lr-status aa-badge">${t.names.length}</div>
    </div>`).join('');
  mount.innerHTML = `<div class="lesson-list">${rows}</div>`;
  mount.querySelectorAll('[data-exam-solutions-trimester]').forEach(row=>{
    row.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const key = row.getAttribute('data-exam-solutions-trimester');
      const t = data.find(x=> x.trimesterKey === key);
      if(t) renderExamSolutionsNamesList(overlay, data, t);
    });
  });
}

/* المستوى الثاني: أسماء التلاميذ الذين أرسلوا حلاً للفصل المختار */
function renderExamSolutionsNamesList(overlay, data, t){
  const mount = overlay.querySelector('#examSolutionsStatsMount');
  const rows = t.names.map(name=> `
    <div class="lesson-row">
      <div class="lr-text"><div class="lr-title">🙋 ${escZoomText(name)}</div></div>
    </div>`).join('');
  mount.innerHTML = `
    <button type="button" class="zoom-back-btn" id="examSolutionsBackToTrimestersBtn">→ رجوع لقائمة الفصول</button>
    <div class="lr-title" style="margin-bottom:10px">📚 ${escZoomText(t.trimesterLabel)}</div>
    <div class="lesson-list">${rows}</div>`;
  mount.querySelector('#examSolutionsBackToTrimestersBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    renderExamSolutionsTrimestersList(overlay, data);
  });
}

/* =========================================================================================
   سجلّ إحصائي لحلول تمارين الزوم — مستقل تمامًا عن إرسال تيليجرام (الذي يبقى كما هو).
   يُسجَّل هنا فقط: الدرس، الفوج، اسم التلميذ ومعرّفه — بلا أي ملف/صورة (تبقى في تيليجرام حصريًا).
   الهدف: تمكين الأستاذ من رؤية "من أرسل ومن لم يرسل" مباشرة من داخل المنصة.
   ========================================================================================= */
const ZoomSolutions = {
  /* وثيقة واحدة لكل (درس + تلميذ) — إعادة إرسال نفس التلميذ لنفس الدرس تُحدّث الوثيقة بدل تكرارها */
  async log(lesson, groupKey, groupLabel){
    if(!fbReady || !Student.id) return;
    try{
      await db.collection('zoomSolutions').doc(`${lesson.id}_${Student.id}`).set({
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        groupKey, groupLabel,
        studentId: Student.id,
        studentName: Student.fullName,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }catch(e){ console.error('تعذّر تسجيل إحصائية حل التمرين:', e); }
  },

  /* كل السجلات مجمّعة حسب الدرس ثم الفوج — لعرضها في نافذة "حلول التلاميذ لتمارين الزوم" */
  async allGrouped(){
    if(!fbReady) return [];
    const snap = await db.collection('zoomSolutions').get();
    const byLesson = new Map(); // lessonId -> { lessonTitle, byGroup: Map(groupKey -> {groupLabel, names:[]}) }
    snap.forEach(doc=>{
      const d = doc.data();
      if(!byLesson.has(d.lessonId)) byLesson.set(d.lessonId, { lessonTitle:d.lessonTitle, byGroup:new Map() });
      const entry = byLesson.get(d.lessonId);
      if(!entry.byGroup.has(d.groupKey)) entry.byGroup.set(d.groupKey, { groupLabel:d.groupLabel, names:[] });
      entry.byGroup.get(d.groupKey).names.push(d.studentName);
    });
    const order = new Map((window.LESSONS||[]).map((l,i)=>[l.id,i]));
    return Array.from(byLesson.entries())
      .map(([lessonId, v])=> ({ lessonId, lessonTitle:v.lessonTitle, groups: Array.from(v.byGroup.values()) }))
      .sort((a,b)=> (order.get(a.lessonId) ?? 999) - (order.get(b.lessonId) ?? 999));
  }
};

/* نافذة "حلول التلاميذ لتمارين الزوم" من لوحة الأستاذ — زر فتح تيليجرام أعلى النافذة،
   وتحتها إحصائيات من أرسل حلاً (الدرس، الفوج، عدد التلاميذ وأسماؤهم) */
function openSolutionsModal(){
  const overlay = document.createElement('div');
  overlay.className = 'zoom-modal-overlay';
  const telegramBtnHtml = (TELEGRAM_CONFIG && TELEGRAM_CONFIG.groupInviteLink)
    ? `<a class="zoom-telegram-btn" style="display:block;text-align:center;text-decoration:none;margin-bottom:18px" href="${TELEGRAM_CONFIG.groupInviteLink}" target="_blank" rel="noopener">▶️ فتح مجموعة الحلول على تيليجرام</a>`
    : `<div class="lesson-cta-note">رابط دعوة المجموعة غير مضبوط في telegram-config.js</div>`;
  overlay.innerHTML = `
    <div class="zoom-modal-popup">
      <div class="zoom-modal-header">
        <div class="zoom-modal-title">📨 حلول التلاميذ للواجب المنزلي المقدم في حصة الزوم</div>
        <div class="zoom-modal-subtitle">افتح المحادثة لمشاهدة الملفات، أو تصفّح من أرسل حلاً لكل درس</div>
        <button type="button" class="zoom-modal-close" id="solutionsModalCloseBtn">✕</button>
      </div>
      <div class="zoom-modal-body" id="solutionsModalBody">
        ${telegramBtnHtml}
        <div id="solutionsStatsMount"><div class="sf-label">جاري تحميل الإحصائيات…</div></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.remove(); });
  overlay.querySelector('#solutionsModalCloseBtn').addEventListener('click', ()=> overlay.remove());

  renderSolutionsStats(overlay);
}

async function renderSolutionsStats(overlay){
  const mount = overlay.querySelector('#solutionsStatsMount');
  if(!fbReady){
    mount.innerHTML = '<div class="lesson-cta-note">Firebase غير مفعّل — لا يمكن عرض الإحصائيات.</div>';
    return;
  }
  let data;
  try{
    data = await ZoomSolutions.allGrouped();
  }catch(e){
    mount.innerHTML = '<div class="lesson-cta-note">تعذّر تحميل الإحصائيات، تحقّق من قواعد أمان Firestore لمجموعة zoomSolutions.</div>';
    return;
  }
  if(!data.length){
    mount.innerHTML = '<div class="lesson-cta-note">لم يُرسل أي تلميذ حلاً بعد.</div>';
    return;
  }
  renderSolutionsLessonsList(overlay, data);
}

/* المستوى الأول: قائمة الدروس — لا يظهر اسم الدرس هنا إطلاقًا إلا بعد وصول أول حل له من أي تلميذ
   (data قادمة أصلًا من ZoomSolutions.allGrouped التي تُبنى من وثائق Firestore الفعلية فقط، فلا يوجد
   أي درس فيها بلا حل؛ هذا الفلتر الإضافي احتياطي فقط لضمان عدم ظهور أي درس مجموع حلوله صفر) */
function renderSolutionsLessonsList(overlay, data){
  const mount = overlay.querySelector('#solutionsStatsMount');
  const withSubmissions = data.filter(l=> l.groups.some(g=> g.names.length>0));
  if(!withSubmissions.length){
    mount.innerHTML = '<div class="lesson-cta-note">لم يُرسل أي تلميذ حلاً بعد.</div>';
    return;
  }
  const rows = withSubmissions.map(l=>{
    const total = l.groups.reduce((s,g)=> s+g.names.length, 0);
    return `<div class="lesson-row zoom-lesson-row" data-solutions-lesson="${escZoomText(l.lessonId)}">
      <div class="lr-text"><div class="lr-title">📘 ${escZoomText(l.lessonTitle)}</div></div>
      <div class="lr-status aa-badge">${total}</div>
    </div>`;
  }).join('');
  mount.innerHTML = `<div class="lesson-list">${rows}</div>`;
  mount.querySelectorAll('[data-solutions-lesson]').forEach(row=>{
    row.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const lessonId = row.getAttribute('data-solutions-lesson');
      const lesson = data.find(l=> String(l.lessonId) === lessonId);
      if(lesson) renderSolutionsGroupsList(overlay, data, lesson);
    });
  });
}

/* المستوى الثاني: أفواج الدرس المختار — أمام كل فوج عدد التلاميذ الذين أرسلوا حلاً منه */
function renderSolutionsGroupsList(overlay, data, lesson){
  const mount = overlay.querySelector('#solutionsStatsMount');
  const rows = lesson.groups.map((g, idx)=> `
    <div class="lesson-row zoom-lesson-row" data-solutions-group="${idx}">
      <div class="lr-text"><div class="lr-title">👥 ${escZoomText(g.groupLabel)}</div></div>
      <div class="lr-status aa-badge">${g.names.length}</div>
    </div>`).join('');
  mount.innerHTML = `
    <button type="button" class="zoom-back-btn" id="solutionsBackToLessonsBtn">→ رجوع لقائمة الدروس</button>
    <div class="lr-title" style="margin-bottom:10px">📘 ${escZoomText(lesson.lessonTitle)}</div>
    <div class="lesson-list">${rows}</div>`;
  mount.querySelector('#solutionsBackToLessonsBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    renderSolutionsLessonsList(overlay, data);
  });
  mount.querySelectorAll('[data-solutions-group]').forEach(row=>{
    row.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const idx = Number(row.getAttribute('data-solutions-group'));
      renderSolutionsNamesList(overlay, data, lesson, lesson.groups[idx]);
    });
  });
}

/* المستوى الثالث: أسماء التلاميذ الذين أرسلوا حلاً، من الفوج المختار فقط */
function renderSolutionsNamesList(overlay, data, lesson, group){
  const mount = overlay.querySelector('#solutionsStatsMount');
  const rows = group.names.map(name=> `
    <div class="lesson-row">
      <div class="lr-text"><div class="lr-title">🙋 ${escZoomText(name)}</div></div>
    </div>`).join('');
  mount.innerHTML = `
    <button type="button" class="zoom-back-btn" id="solutionsBackToGroupsBtn">→ رجوع لأفواج الدرس</button>
    <div class="lr-title" style="margin-bottom:10px">📘 ${escZoomText(lesson.lessonTitle)} — 👥 ${escZoomText(group.groupLabel)}</div>
    <div class="lesson-list">${rows}</div>`;
  mount.querySelector('#solutionsBackToGroupsBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    renderSolutionsGroupsList(overlay, data, lesson);
  });
}


async function renderLessonExercisesBox(lesson){
  const box = document.getElementById('ldExercisesBox');
  box.innerHTML = '<div class="sf-label">جاري التحقق من التمارين…</div>';

  const data = await loadLessonExercise(lesson.id);
  if(!data){
    box.innerHTML = `
      <div class="lesson-cta-note">⏳ تمارين هذا الدرس غير متوفرة بعد — سيقوم الأستاذ/المشرف بإضافتها قريبًا. عند توفرها ستكون محاولة واحدة فقط، وتُحسب النتيجة بالنسبة المئوية وتدخل الترتيب.</div>`;
    return;
  }

  const mine = await Leaderboard.mine(lesson.id);
  /* صيغتان مدعومتان لملف التمارين:
     1) { questions:[...] }  → اختيار من متعدد (المحرك القديم createExerciseEngine)
     2) { sections:[...] }   → تمارين الكتاب كما هي، كل تمرين (قسم) يُعرض دفعة واحدة في صفحة واحدة
                                 تمامًا كما يظهر في ورقة التمرين الأصلية (أكمل الفراغ/الإعراب/المعنى/الجملة/الاستخراج) */
  const units = Array.isArray(data.questions) ? null : buildExercisePages(data);
  const count = units ? units.length : data.questions.length;
  const countLabel = units ? 'عدد التمارين' : 'عدد الأسئلة';

  if(mine && mine.completed === false){
    /* التلميذ بدأ هذا التمرين سابقًا ولم يُتمّه (محاولة مسجَّلة تدريجيًا) — إجاباته على التمارين
       الفرعية المُنجَزة محفوظة بالفعل (sectionsDone + scoreSum)، فنتيح له إكمال الباقي فقط بدل
       حجب الوصول بالكامل. */
    const doneCount = Math.min(mine.sectionsDone||0, units ? units.length : 0);
    box.innerHTML = `
      <div class="lesson-cta-note" style="color:#8a6d1a;border-color:#c9982f">
        ⏳ لديك محاولة سابقة لم تكتمل بعد في تمرين هذا الدرس — أنجزتَ ${doneCount} من ${count}، وإجاباتك محفوظة.
        يمكنك إكمال بقية التمارين الآن متى شئت.
      </div>
      <button class="lesson-cta-btn" id="ldExerciseResumeBtn">▶️ إكمال التمرين من حيث توقفت</button>
      <div id="ldExerciseMount" style="margin-top:14px"></div>`;
    document.getElementById('ldExerciseResumeBtn').addEventListener('click', ()=>{
      document.getElementById('ldExerciseResumeBtn').style.display = 'none';
      const mount = document.getElementById('ldExerciseMount');
      /* fallback للسجلات القديمة السابقة لهذه الميزة والتي لا تحمل scoreSum: نُقدّره من النسبة
         المئوية المحفوظة (percent) بدل البدء من صفر، تفاديًا لخسارة نقاط التمارين المُنجزة فعلاً. */
      const initialScoreSum = (typeof mine.scoreSum === 'number') ? mine.scoreSum : ((mine.percent||0)/100)*units.length;
      createOpenExerciseEngine(lesson, units, mount, { startIdx: doneCount, initialScoreSum });
    });
    return;
  }
  if(mine && typeof mine.percent === 'number'){
    const pct = mine.percent;
    const tier = pct>=90?'excellent':(pct>=60?'good':'retry');
    const emoji = pct>=90?'🏆':(pct>=60?'💪':'🌱');
    box.innerHTML = `
      <div class="result-card ${tier}">
        <div class="result-emoji">${emoji}</div>
        <div class="result-gauge" style="--pct:${pct}"><div class="rg-pct">${pct}%</div></div>
        <div class="result-title">لقد أتممتَ تمرين هذا الدرس</div>
        <div class="result-msg">هذه نتيجتك المسجّلة — محاولة واحدة فقط لكل تلميذ، ولا يمكن إعادتها.</div>
      </div>
      <div id="ldExercisesPdfButtons"></div>`;
    /* التلميذ اجتاز هذا التمرين فعلاً (نتيجته محفوظة في قاعدة البيانات) — أزرار تحميل PDF
       يجب أن تظهر هنا في كل مرة يُفتح فيها الدرس من جديد، وليس فقط لحظة الإنهاء الأولى،
       لأن data (محتوى التمرين) محمّل مسبقًا في هذه الدالة أصلاً. */
    addPdfDownloadButtons(lesson, data, document.getElementById('ldExercisesPdfButtons'));
    return;
  }

  box.innerHTML = `
    <button class="lesson-cta-btn" id="ldExerciseStartBtn">▶️ ابدأ التمرين</button>
    <div class="lesson-cta-note">⚠️ محاولة واحدة فقط — ${countLabel}: ${count}. تُحسب نتيجة كل تمرين فور إتمامه وتُحفظ تلقائيًا؛ إذا انقطع اتصالك أو أغلقتَ التطبيق في المنتصف يمكنك متابعة الباقي لاحقًا من حيث توقفتَ. تُحسب نتيجتك النهائية بالنسبة المئوية وتدخل ترتيب هذا الدرس.</div>
    <div id="ldExerciseMount" style="margin-top:14px"></div>`;

  document.getElementById('ldExerciseStartBtn').addEventListener('click', async ()=>{
    const startBtn = document.getElementById('ldExerciseStartBtn');
    startBtn.disabled = true;
    /* المحرك القديم (اختيار من متعدد) لا يدعم بعد الحفظ التدريجي فيُبقى سلوكه كما كان؛
       أما تمارين الكتاب (units) فتُسجَّل فور الضغط على "ابدأ" لمنع إعادة المحاولة بتحديث الصفحة. */
    if(units){
      const started = await Leaderboard.startAttempt(lesson.id);
      if(!started.ok){
        renderLessonExercisesBox(lesson); // أُعيد رسم الصندوق ليعكس الحالة الحقيقية (محاولة سابقة)
        return;
      }
    }
    startBtn.style.display = 'none';
    const mount = document.getElementById('ldExerciseMount');
    if(units) createOpenExerciseEngine(lesson, units, mount);
    else createExerciseEngine(lesson, data.questions, mount);
  });
}

/* ---------- محرك «تمارين الدرس» — اختيار من متعدد، محاولة واحدة، يُسجَّل في الترتيب ---------- */
function createExerciseEngine(lesson, questions, mountEl){
  const total = questions.length;
  const order = shuffleArr(questions.map((_,i)=>i));
  let idx = 0, correctCount = 0;
  const startTs = Date.now(); /* لحساب مدة إنجاز التمرين — تُستخدم للفصل عند تعادل النسبة المئوية في الترتيب */

  function renderQuestion(){
    const qIndex = order[idx];
    const item = questions[qIndex];
    const opts = item.options.map((opt,oi)=>`<button class="mcq-btn" data-oi="${oi}">${opt}</button>`).join('');
    mountEl.innerHTML = `
      <div class="quiz-progress">سؤال ${idx+1} من ${total}</div>
      <div class="quiz-card">
        <div class="quiz-q">${item.q}</div>
        <div class="quiz-opts">${opts}</div>
        <div class="quiz-explain" style="display:none"></div>
        <button class="quiz-next-btn" style="display:none">${idx+1<total ? 'التالي ←' : 'إنهاء وإرسال ✅'}</button>
      </div>`;
    const btns = Array.from(mountEl.querySelectorAll('.mcq-btn'));
    btns.forEach(b=>{
      b.addEventListener('click', ()=>{
        btns.forEach(x=>x.disabled = true);
        const oi = parseInt(b.getAttribute('data-oi'));
        const ok = oi === item.correct;
        if(ok){ if(window.SoundFX) SoundFX.correct(); b.classList.add('correct'); correctCount++; }
        else {
          if(window.SoundFX) SoundFX.wrong();
          b.classList.add('wrong');
          if(btns[item.correct]) btns[item.correct].classList.add('correct');
          const ex = mountEl.querySelector('.quiz-explain');
          if(item.explain){ ex.innerHTML = item.explain; ex.style.display = 'block'; }
        }
        mountEl.querySelector('.quiz-next-btn').style.display = 'inline-block';
      });
    });
    mountEl.querySelector('.quiz-next-btn').addEventListener('click', ()=>{
      idx++;
      if(idx >= total) finishExercise(lesson, mountEl, Math.round((correctCount/total)*100), Math.round((Date.now()-startTs)/1000));
      else renderQuestion();
    });
  }

  renderQuestion();
}

/* ---------- تطبيع ومطابقة النصوص العربية (تسامح في الصياغة، مثل صفحة التمارين الأصلية) ---------- */
/* ---------- التسجيل الصوتي لحقول الإجابة النصية (Web Speech API) ---------- */
const QuizSpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
function attachQuizMic(btn, targetEl){
  if(!btn || !targetEl) return;
  if(!QuizSpeechRec){ btn.disabled = true; btn.title = 'التعرف الصوتي غير مدعوم على هذا الجهاز'; return; }
  btn.addEventListener('click', ()=>{
    const rec = new QuizSpeechRec();
    rec.lang = 'ar-SA'; rec.interimResults = false; rec.maxAlternatives = 1;
    btn.classList.add('listening');
    try{ rec.start(); }catch(e){ btn.classList.remove('listening'); return; }
    rec.onresult = (e)=>{ targetEl.value = e.results[0][0].transcript; };
    rec.onend = ()=> btn.classList.remove('listening');
    rec.onerror = ()=> btn.classList.remove('listening');
  });
}

function normalizeArabic(s){
  return (s||'')
    .replace(/[\u064B-\u0652\u0670\u0640]/g,'')
    .replace(/[إأآا]/g,'ا').replace(/ى/g,'ي').replace(/ؤ/g,'و').replace(/ئ/g,'ي')
    .replace(/[^\u0600-\u06FF\s]/g,'').trim().replace(/\s+/g,' ');
}
function wordOverlapRatioAr(a,b){
  const wa = normalizeArabic(a).split(' ').filter(Boolean);
  const wb = normalizeArabic(b).split(' ').filter(Boolean);
  if(!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  let common = 0;
  wa.forEach(w=>{ if(setB.has(w)) common++; });
  return common / Math.max(wa.length, wb.length);
}
function isMatchAr(user, model, loose){
  const nu = normalizeArabic(user), nm = normalizeArabic(model);
  if(!nu) return false;
  if(nu === nm) return true;
  return wordOverlapRatioAr(nu, nm) >= (loose ? 0.4 : 0.7);
}
/* تصحيح متسامح بالمعنى: يتحقق من وجود الأفكار/الكلمات المفتاحية الأساسية في إجابة التلميذ
   دون اشتراط تطابق الصياغة الحرفية أو ترتيب الكلمات. يُستعمل عند توفّر "keywords" في عنصر السؤال. */
function keywordScoreAr(user, keywords){
  if(!keywords || !keywords.length) return null;
  const nu = normalizeArabic(user);
  if(!nu) return 0;
  const userWords = nu.split(' ').filter(Boolean);
  let found = 0;
  keywords.forEach(kw=>{
    const nkw = normalizeArabic(kw);
    if(!nkw) return;
    const isPhrase = nkw.includes(' ');
    const hit = isPhrase ? nu.includes(nkw) : userWords.includes(nkw);
    if(hit) found++;
  });
  return found / keywords.length;
}
function isMeaningMatchAr(user, item){
  if(item && Array.isArray(item.keywords) && item.keywords.length){
    const score = keywordScoreAr(user, item.keywords);
    return score !== null && score >= (item.keywordThreshold || 0.5);
  }
  return isMatchAr(user, item && item.answer, true);
}
function containsWordAr(user, word){
  const nu = normalizeArabic(user), nw = normalizeArabic(word);
  return nu.split(' ').includes(nw);
}

/* ---------- أقسام ملف التمارين (sections) ---------- */
/* كل قسم (section) = تمرين كامل كما يظهر في ورقة الكتاب، ويُعرض دفعة واحدة في صفحة واحدة
   بكل فقراته/أسئلته الفرعية معًا — لا تفتيت لتمرين واحد إلى شاشات متتالية منفصلة. */
function buildExercisePages(data){
  return data.sections || [];
}

/* ---------- محرك «تمارين الدرس» — كل تمرين (قسم) في صفحة واحدة كاملة، كما في ورقة الكتاب ---------- */
function createOpenExerciseEngine(lesson, pages, mountEl, opts={}){
  const total = pages.length;
  /* استئناف تمرين سابق غير مكتمل: نبدأ من أول تمرين فرعي لم يُنجَز بعد (startIdx)، ونعيد نفس
     مجموع النقاط الخام المحفوظ مسبقًا (initialScoreSum) حتى تبقى النسبة المئوية النهائية دقيقة. */
  let idx = Math.min(Math.max(opts.startIdx||0, 0), total), scoreSum = opts.initialScoreSum || 0;
  const startTs = Date.now(); /* لحساب مدة إنجاز التمرين — تُستخدم للفصل عند تعادل النسبة المئوية في الترتيب */

  function pageHeader(sec){
    const num = sec.number ? `التمرين ${sec.number}` : (sec.title || '');
    return `
      <div class="quiz-progress">تمرين ${idx+1} من ${total}</div>
      <div class="book-header-card">
        <div class="book-exercise-title">${sec.title || num}</div>
        ${sec.instructions ? `<div class="book-exercise-instr">${sec.instructions}</div>` : ''}
      </div>`;
  }

  function goNext(){
    idx++;
    if(idx >= total) finish(); else renderPage();
  }

  /* حفظ فوري لتقدّم التلميذ في قاعدة البيانات فور إتمام كل تمرين فرعي (بعد «تحقق»)، حتى لا تُفقد
     إجاباته المُنجزة إن انقطع اتصاله أو أغلق التطبيق — ويمكنه إكمال الباقي لاحقًا من نفس النقطة. */
  function saveProgressNow(){
    const partialPercent = Math.round((scoreSum/total)*100);
    Leaderboard.saveProgress(lesson.id, idx+1, partialPercent, scoreSum);
  }


  function nextBtnHtml(){
    return `<button class="quiz-next-btn" style="display:none">${idx+1<total ? 'التمرين التالي ←' : 'إنهاء وإرسال ✅'}</button>`;
  }

  function renderPage(){
    const sec = pages[idx];
    if(sec.type === 'extract') return renderExtractPage(sec);
    if(sec.type === 'fill' && Array.isArray(sec.passage)) return renderFillPassagePage(sec);
    if(sec.type === 'fill') return renderFillListPage(sec);
    if(sec.type === 'irab') return renderWordListPage(sec, 'irab');
    if(sec.type === 'term') return renderWordListPage(sec, 'term');
    if(sec.type === 'sentence') return renderWordListPage(sec, 'sentence');
    /* نوع غير معروف — تخطٍّ آمن */
    scoreSum += 1; goNext();
  }

  /* ===== ١) تمرين «أكمل الفراغات» بصياغة فقرة متواصلة مع فراغات داخلية (passage) ===== */
  function renderFillPassagePage(sec){
    const html = (sec.passage||[]).map((tok,i)=>{
      if(tok.blank){
        const w = Math.max(60, Math.min(220, 18*((tok.answer||'').length)+30));
        return `<input type="text" class="inline-blank-input" data-bid="${i}" style="width:${w}px" autocomplete="off">`;
      }
      return epTextSpan(tok.text||'');
    }).join('');

    mountEl.innerHTML = `
      ${pageHeader(sec)}
      <div class="quiz-card">
        <div class="passage-block">${html}</div>
        <div style="text-align:center">
          <button class="quiz-check-btn" id="unitCheckBtn" type="button">تحقق</button>
        </div>
        <div class="quiz-explain" style="display:none"></div>
        ${nextBtnHtml()}
      </div>`;

    document.getElementById('unitCheckBtn').addEventListener('click', ()=>{
      const blanks = (sec.passage||[]).map((tok,i)=> tok.blank ? {tok,i} : null).filter(Boolean);
      let correct = 0;
      blanks.forEach(({tok,i})=>{
        const inp = mountEl.querySelector(`.inline-blank-input[data-bid="${i}"]`);
        const ok = isMatchAr(inp.value, tok.answer, true);
        inp.classList.add(ok ? 'correct' : 'wrong');
        inp.disabled = true;
        if(ok) correct++;
      });
      const ratio = blanks.length ? correct/blanks.length : 1;
      if(window.SoundFX) (ratio>=1 ? SoundFX.correct() : SoundFX.wrong());
      scoreSum += Math.min(1, ratio);
      saveProgressNow();
      document.getElementById('unitCheckBtn').disabled = true;
      const model = (sec.passage||[]).map(tok=> tok.blank ? `«${epTextSpan(tok.answer||'')}»` : epTextSpan(tok.text||'')).join('');
      const ex = mountEl.querySelector('.quiz-explain');
      ex.innerHTML = `<b>لقيتَ ${correct} فراغًا صحيحًا من أصل ${blanks.length}.</b>
        <div class="quiz-model-answer">الحل النموذجي الكامل: ${model}</div>`;
      ex.style.display = 'block';
      mountEl.querySelector('.quiz-next-btn').style.display = 'inline-block';
    });
    mountEl.querySelector('.quiz-next-btn').addEventListener('click', goNext);
  }

  /* ===== نسخة احتياطية (توافقية) لتمرين «أكمل الفراغ» القديم — قائمة عناصر before/after/answer معًا في صفحة واحدة ===== */
  function renderFillListPage(sec){
    const items = sec.items || [];
    const rows = items.map((it,i)=>{
      const blank = it.multiline
        ? `<textarea class="inline-blank-input inline-blank-textarea" data-ri="${i}" rows="3" autocomplete="off"></textarea>`
        : `<input type="text" class="inline-blank-input" data-ri="${i}" autocomplete="off">`;
      return `
      <div class="book-item-row" data-ri="${i}">
        <div class="book-item-sentence">${items.length>1?`${i+1}) `:''}${epTextSpan(it.before||'')} ${blank} ${epTextSpan(it.after||'')}</div>
        <div class="book-item-feedback" style="display:none"></div>
      </div>`;
    }).join('');

    mountEl.innerHTML = `
      ${pageHeader(sec)}
      <div class="quiz-card">
        ${rows}
        <div style="text-align:center">
          <button class="quiz-check-btn" id="unitCheckBtn" type="button">تحقق</button>
        </div>
        ${nextBtnHtml()}
      </div>`;

    document.getElementById('unitCheckBtn').addEventListener('click', ()=>{
      let correct = 0;
      items.forEach((it,i)=>{
        const inp = mountEl.querySelector(`.inline-blank-input[data-ri="${i}"]`);
        const ok = isMeaningMatchAr(inp.value, it);
        inp.classList.add(ok ? 'correct' : 'wrong');
        inp.disabled = true;
        const fb = mountEl.querySelector(`.book-item-row[data-ri="${i}"] .book-item-feedback`);
        fb.style.display = 'block';
        fb.innerHTML = ok ? '<b style="color:var(--sage-deep)">✓ صحيحة</b>' : `<b style="color:#C94848">✗ الحل النموذجي: ${epTextSpan(it.answer||'')}</b>`;
        if(ok) correct++;
      });
      const ratio = items.length ? correct/items.length : 1;
      if(window.SoundFX) (ratio>=1 ? SoundFX.correct() : SoundFX.wrong());
      scoreSum += Math.min(1, ratio);
      saveProgressNow();
      document.getElementById('unitCheckBtn').disabled = true;
      mountEl.querySelector('.quiz-next-btn').style.display = 'inline-block';
    });
    mountEl.querySelector('.quiz-next-btn').addEventListener('click', goNext);
  }

  /* ===== ٢) تمرين «استخرج» (+ «أعرب ما تحته خط» إن وُجد) — نفس الفقرة، صفحة واحدة، سؤالان معًا ===== */
  function renderExtractPage(sec){
    const irabItems = sec.irabItems || [];
    let rowCount = 0;

    const irabRows = irabItems.map((it,i)=>`
      <div class="book-item-row" data-iri="${i}">
        <div class="quiz-term-label" style="font-size:14px">${epTextSpan(it.word||'')}</div>
        <textarea class="quiz-textarea" data-iri="${i}" placeholder="اكتب الإعراب هنا"></textarea>
        <div class="book-item-feedback" style="display:none"></div>
      </div>`).join('');

    mountEl.innerHTML = `
      ${pageHeader(sec)}
      <div class="quiz-card">
        <div class="extract-source">${sec.sourceText||''}</div>
        ${sec.extractInstructions ? `<div class="book-sub-instr">${sec.extractInstructions}</div>` : ''}
        <table class="extract-table">
          <thead><tr><th>المعطوف عليه</th><th>حرف العطف</th><th>المعطوف</th><th></th></tr></thead>
          <tbody id="extractRows"></tbody>
        </table>
        <button class="extract-add-btn" id="extractAddBtn" type="button">+ أضف حالة</button>
        ${irabItems.length ? `
          ${sec.irabInstructions ? `<div class="book-sub-instr">${sec.irabInstructions}</div>` : ''}
          ${irabRows}
        ` : ''}
        <div style="text-align:center">
          <button class="quiz-check-btn" id="unitCheckBtn" type="button">تحقق وإنهاء هذا التمرين</button>
        </div>
        <div class="quiz-explain" style="display:none"></div>
        ${nextBtnHtml()}
      </div>`;

    const tbody = document.getElementById('extractRows');
    function addRow(){
      const rid = rowCount++;
      const tr = document.createElement('tr');
      tr.className = 'extract-row';
      tr.dataset.rid = rid;
      tr.innerHTML = `
        <td><input type="text" data-f="before"></td>
        <td><input type="text" data-f="conj"></td>
        <td><input type="text" data-f="after"></td>
        <td><button type="button" class="extract-row-remove">✕</button></td>`;
      tr.querySelector('.extract-row-remove').addEventListener('click', ()=> tr.remove());
      tbody.appendChild(tr);
    }
    document.getElementById('extractAddBtn').addEventListener('click', addRow);
    for(let i=0;i<Math.max(3, (sec.pairs||[]).length);i++) addRow();

    document.getElementById('unitCheckBtn').addEventListener('click', ()=>{
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const usedModel = new Set();
      let matched = 0;
      rows.forEach(row=>{
        const before = row.querySelector('[data-f="before"]').value;
        const conj = row.querySelector('[data-f="conj"]').value;
        const after = row.querySelector('[data-f="after"]').value;
        if(!before && !conj && !after) return;
        let foundIdx = -1;
        (sec.pairs||[]).forEach((m, mIdx)=>{
          if(foundIdx !== -1 || usedModel.has(mIdx)) return;
          if(isMatchAr(before, m.before, true) && isMatchAr(conj, m.conj, false) && isMatchAr(after, m.after, true)) foundIdx = mIdx;
        });
        if(foundIdx !== -1){ usedModel.add(foundIdx); matched++; row.style.color = 'var(--sage-deep)'; }
        else { row.style.color = '#C94848'; }
      });
      const extractRatio = (sec.pairs||[]).length ? matched / sec.pairs.length : 1;

      let irabCorrect = 0;
      irabItems.forEach((it,i)=>{
        const ta = mountEl.querySelector(`textarea[data-iri="${i}"]`);
        const ok = isMeaningMatchAr(ta.value, it);
        ta.disabled = true;
        const fb = mountEl.querySelector(`.book-item-row[data-iri="${i}"] .book-item-feedback`);
        fb.style.display = 'block';
        fb.innerHTML = `<b style="color:${ok?'var(--sage-deep)':'#C94848'}">${ok?'✓ صحيحة':'✗ إجابة غير مطابقة'}</b><div class="quiz-model-answer">الحل النموذجي: ${epTextSpan(it.answer||'')}</div>`;
        if(ok) irabCorrect++;
      });
      const irabRatio = irabItems.length ? irabCorrect/irabItems.length : null;

      const w1 = (sec.pairs||[]).length || 1;
      const w2 = irabItems.length;
      const combined = irabRatio===null ? extractRatio : ((extractRatio*w1)+(irabRatio*w2))/(w1+w2);

      if(window.SoundFX) (combined>=1 ? SoundFX.correct() : SoundFX.wrong());
      scoreSum += Math.min(1, combined);
      saveProgressNow();
      Array.from(tbody.querySelectorAll('input')).forEach(i=> i.disabled = true);
      document.getElementById('extractAddBtn').disabled = true;
      document.getElementById('unitCheckBtn').disabled = true;
      const ex = mountEl.querySelector('.quiz-explain');
      ex.innerHTML = `<b>الاستخراج: لقيتَ ${matched} حالة صحيحة من أصل ${(sec.pairs||[]).length}.</b>
        <div class="quiz-model-answer">الحل النموذجي الكامل: ${(sec.pairs||[]).map(p=>`(${p.before} ${p.conj} ${p.after})`).join('، ')}</div>`;
      ex.style.display = 'block';
      mountEl.querySelector('.quiz-next-btn').style.display = 'inline-block';
    });
    mountEl.querySelector('.quiz-next-btn').addEventListener('click', goNext);
  }

  /* ===== ٣) تمرين قائمة (إعراب / معنى حرف / توظيف حرف في جملة) — كل عناصر التمرين معًا في صفحة واحدة ===== */
  function renderWordListPage(sec, kind){
    const items = sec.items || [];
    const rowsHtml = items.map((it,i)=>{
      const label = kind==='irab' ? (it.word||'') : (it.term||'');
      const sub = kind==='irab' ? 'أعرب هذه الكلمة' : (kind==='term' ? 'ما المعنى الذي يفيده هذا الحرف؟' : 'وظّف هذا الحرف في جملة من إنشائك');
      const inputTag = kind==='irab'
        ? `<textarea class="quiz-textarea" data-ri="${i}" placeholder="اكتب الإعراب هنا"></textarea>`
        : `<input type="text" class="quiz-text-input" data-ri="${i}" placeholder="${kind==='term'?'اكتب المعنى هنا':'اكتب جملتك هنا'}">`;
      return `
        <div class="book-item-row" data-ri="${i}">
          <div class="quiz-term-label">${i+1}) ${epTextSpan(label)}</div>
          <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:8px">${sub}</div>
          ${inputTag}
          <div class="book-item-feedback" style="display:none"></div>
        </div>`;
    }).join('');

    mountEl.innerHTML = `
      ${pageHeader(sec)}
      <div class="quiz-card">
        ${rowsHtml}
        <div style="text-align:center">
          <button class="quiz-check-btn" id="unitCheckBtn" type="button">تحقق وإنهاء هذا التمرين</button>
        </div>
        ${nextBtnHtml()}
      </div>`;

    document.getElementById('unitCheckBtn').addEventListener('click', ()=>{
      let correct = 0;
      items.forEach((it,i)=>{
        const inp = mountEl.querySelector(`[data-ri="${i}"].quiz-text-input, [data-ri="${i}"].quiz-textarea`);
        const val = inp.value;
        let ok, note;
        if(kind === 'sentence'){
          ok = containsWordAr(val, it.term) && normalizeArabic(val).split(' ').filter(Boolean).length >= 4;
          note = ok ? '✓ وظّفتَ الحرف في جملة مقبولة' : '✗ تأكد أن جملتك تحتوي الحرف وتكون جملة كاملة';
        } else {
          ok = isMeaningMatchAr(val, it);
          note = ok ? '✓ إجابة صحيحة' : '✗ إجابة غير مطابقة';
        }
        inp.disabled = true;
        const fb = mountEl.querySelector(`.book-item-row[data-ri="${i}"] .book-item-feedback`);
        const modelLine = (kind !== 'sentence' && it.answer) ? `<div class="quiz-model-answer">الحل النموذجي: ${epTextSpan(it.answer||'')}</div>` : '';
        fb.style.display = 'block';
        fb.innerHTML = `<b style="color:${ok?'var(--sage-deep)':'#C94848'}">${note}</b>${modelLine}`;
        if(ok) correct++;
      });
      const ratio = items.length ? correct/items.length : 1;
      if(window.SoundFX) (ratio>=1 ? SoundFX.correct() : SoundFX.wrong());
      scoreSum += Math.min(1, ratio);
      saveProgressNow();
      document.getElementById('unitCheckBtn').disabled = true;
      mountEl.querySelector('.quiz-next-btn').style.display = 'inline-block';
    });
    mountEl.querySelector('.quiz-next-btn').addEventListener('click', goNext);
  }

  function finish(){
    const pct = Math.round((scoreSum/total)*100);
    finishExercise(lesson, mountEl, pct, Math.round((Date.now()-startTs)/1000));
  }

  if(idx >= total) finish(); else renderPage();
}

/* هروب بسيط من HTML عند حقن نص حر داخل الصفحة (العناوين/الفقرات القادمة من ملفات JSON) */
function epTextSpan(s){
  return (s==null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ---------- إنهاء أي تمرين (اختيار من متعدد أو مفتوح): حفظ النتيجة النهائية في الترتيب ---------- */
async function finishExercise(lesson, mountEl, pct, timeSeconds){
  mountEl.innerHTML = '<div class="sf-label">جاري حفظ نتيجتك…</div>';
  const res = await Leaderboard.submit(lesson.id, pct, timeSeconds);
  let tier='retry', emoji='🌱', title='لا بأس، البداية دائمًا هكذا!',
      msg='راجع الدرس جيدًا. النتيجة سُجّلت في ترتيب هذا الدرس.';
  if(pct>=90){ tier='excellent'; emoji='🏆'; title='أداء استثنائي يا نجم! 🌟'; msg='لقد أتقنت هذا الدرس بامتياز!'; }
  else if(pct>=60){ tier='good'; emoji='💪'; title='أحسنت، نتيجة جيدة جدًا!'; msg='نتيجة جيدة! راجع الأخطاء البسيطة لاحقًا.'; }
  mountEl.innerHTML = `
    <div class="result-card ${tier}">
      <div class="result-emoji">${emoji}</div>
      <div class="result-gauge" style="--pct:${pct}"><div class="rg-pct">${pct}%</div></div>
      <div class="result-title">${title}</div>
      <div class="result-msg">${msg}</div>
    </div>
    ${res && res.ok
      ? '<p style="text-align:center;font-weight:800;color:#3F6350;margin-top:10px">✅ تم تسجيل نتيجتك في ترتيب هذا الدرس.</p>'
      : '<p style="text-align:center;font-weight:700;color:#c0392b;margin-top:10px">⚠️ تعذّر حفظ نتيجتك في قاعدة البيانات (تحقق من الاتصال). راجع الأستاذ إن استمرت المشكلة.</p>'}
    ${pct === 100 ? `<div style="text-align:center;margin-top:12px"><button class="cert-download-btn" id="exerciseCertBtn">🎓 احصل على شهادة تقديرك</button></div>` : ''}
    <div id="pdfButtonsContainer"></div>`;

  if(pct === 100){
    document.getElementById('exerciseCertBtn').addEventListener('click', ()=>{
      openCertificateModal(lesson, pct);
    });
  }

  /* إضافة أزرار تحميل PDF بعد تسجيل النتيجة بنجاح */
  if(res && res.ok){
    const exerciseData = await loadLessonExercise(lesson.id);
    if(exerciseData){
      const btnContainer = document.getElementById('pdfButtonsContainer');
      addPdfDownloadButtons(lesson, exerciseData, btnContainer);
    }
  }
}

/* ---------- تصدير الخريطة الذهنية للدرس كملف PDF (تحميل مباشر) ----------
   تُبنى نسخة كاملة من الخريطة الذهنية (كل الأقسام مفتوحة دائمًا، بنفس الألوان والإطارات)
   في حاوية خارج نطاق الشاشة المرئية (#mindmapPrintArea)، ثم تُلتقط كصورة عبر html2canvas
   وتُحوَّل إلى ملف PDF فعلي عبر jsPDF ويُنزَّل مباشرة على جهاز التلميذ (بلا نافذة طباعة).
   يتطلب هذا اتصالاً بالإنترنت لتحميل مكتبتي html2canvas وjsPDF (عبر CDN) عند أول استخدام. */
function buildMindmapPrintBranchHTML(branch){
  const childrenHtml = (branch.children||[]).map(ch=>`
    <div class="pp-leaf">
      <span class="pp-leaf-title">${ch.title}</span>
      ${ch.rule?`<div class="pp-leaf-rule">${ch.rule}</div>`:''}
      ${ch.example?`<div class="pp-leaf-example">✏️ ${ch.example}</div>`:''}
    </div>`).join('');
  return `<div class="pp-branch c-${branch.color||'blue'}">
    <div class="pp-branch-head">${branch.title}</div>
    <div class="pp-branch-body">
      ${branch.rule?`<div class="pp-rule">${branch.rule}</div>`:''}
      ${branch.example?`<div class="pp-example">✏️ ${branch.example}</div>`:''}
      ${childrenHtml?`<div class="pp-children">${childrenHtml}</div>`:''}
    </div>
  </div>`;
}

/* تنتظر تحميل مكتبتي html2canvas وjsPDF من الإنترنت (قد يتأخرا قليلاً حسب سرعة الاتصال
   أو تُحجبان من بعض برامج حجب الإعلانات/جدران حماية الشبكة)، وتفشل بخطأ واضح بعد مهلة معقولة */
function waitForPdfLibs(timeoutMs = 10000){
  return new Promise((resolve, reject)=>{
    const start = Date.now();
    (function check(){
      const ready = (typeof html2canvas !== 'undefined') && window.jspdf && window.jspdf.jsPDF;
      if(ready) return resolve();
      if(Date.now() - start > timeoutMs){
        return reject(new Error('تعذّر تحميل مكوّنات إنشاء PDF من الإنترنت. تأكد من اتصالك، ومن أن أي برنامج حجب إعلانات أو جدار حماية للشبكة لا يمنع تحميل ملفات جافاسكريبت خارجية، ثم أعد المحاولة.'));
      }
      setTimeout(check, 200);
    })();
  });
}

/* تضمن اكتمال تحميل خط Cairo (المستخدم الآن حصريًا في كامل قالب طباعة الـ PDF، بما في ذلك
   عنوان المنصة وعنوان الدرس) فعليًا في المتصفح قبل التقاط الصورة، لتفادي أي خط احتياطي مؤقت. */
async function ensureMindmapFontsLoaded(){
  if(!(document.fonts && document.fonts.load)) return;
  try{
    await Promise.all([
      document.fonts.load('900 21px Cairo'),
      document.fonts.load('800 17px Cairo'),
      document.fonts.load('700 12px Cairo'),
      document.fonts.load('600 12px Cairo'),
      document.fonts.load('400 12px Cairo')
    ]);
    if(document.fonts.ready) await document.fonts.ready;
  }catch(e){
    /* لا نوقف عملية التصدير أبدًا بسبب فشل تحميل خط واحد — نتابع بأفضل خط متاح */
  }
}

/* تقدير "ثِقَل" محتوى الدرس (عدد الفروع + الأبناء + طول التعريف) لاختيار حجم خط/مسافات
   مناسب تلقائيًا حتى تتسع الخريطة الذهنية بأناقة داخل صفحة A4 واحدة دائمًا مهما طال الدرس */
function estimateMindmapPrintSizeClass(lesson){
  const branches = lesson.tree || [];
  const totalChildren = branches.reduce((acc,b)=> acc + ((b.children||[]).length), 0);
  const defLen = (lesson.def||'').replace(/<[^>]*>/g,'').length;
  const weight = (branches.length*3) + totalChildren + Math.floor(defLen/55);
  if(weight > 38) return 'pp-ultra-compact';
  if(weight > 22) return 'pp-compact';
  return '';
}

function exportMindmapPDF(lesson, btnEl){
  if(!lesson.tree || !lesson.tree.length) return;
  const btn = btnEl || document.getElementById('ldMindmapPdfBtn');
  const area = document.getElementById('mindmapPrintArea');

  const sizeClass = estimateMindmapPrintSizeClass(lesson);
  area.innerHTML = `
    <div class="pp-page ${sizeClass}">
      <div class="pp-header">
        <div class="pp-platform">منصة الأستاذ يوسف سعدي</div>
        <div class="pp-level">اللغة العربية — السنة الرابعة متوسط</div>
        <div class="pp-lesson-title">🗺️ الخريطة الذهنية: ${lesson.title}</div>
      </div>
      ${lesson.def ? `<div class="pp-def">${lesson.def}</div>` : ''}
      <div class="pp-branches">
        ${lesson.tree.map(buildMindmapPrintBranchHTML).join('')}
      </div>
      <div class="pp-footer">إعداد الأستاذ: يوسف سعدي</div>
    </div>`;

  const originalBtnHTML = btn.innerHTML;
  btn.innerHTML = '⏳ جارٍ التحضير...';
  btn.disabled = true;

  /* التقاط عنصر .pp-page كصورة عبر html2canvas مع ضمانات صريحة ضد أشهر أخطاء المكتبة:
     1) تجاهل أي عنصر خلفية عائم في الصفحة (مثل صورة الأستاذ الشفافة/العلامة المائية) حتى
        لا يظهر أي أثر لها إطلاقًا في خلفية ملف الـ PDF الناتج.
     2) عدم استخدام أي تدرّج لوني (gradient) داخل قالب الطباعة نفسه — القالب يعتمد ألوانًا
        صلبة فقط — لتفادي خطأ addColorStop الشهير الذي يقع عندما تحاول html2canvas رسم
        تدرّجات لونية معقّدة أو نص مقصوص بتدرّج (background-clip:text).
     3) تحجيم (scale) تلقائي يتناسب مع ارتفاع المحتوى الفعلي بدل قيمة ثابتة، لتفادي تجاوز
        الحد الأقصى لأبعاد الـ canvas المسموح بها في متصفحات الجوّال. */
  (async ()=>{
    const ignoreFloatingBackgrounds = (el)=>{
      if(!el || !el.classList) return false;
      return el.classList.contains('teacher-watermark') || el.classList.contains('islamic-pattern');
    };
    const forceCleanClone = (clonedDoc)=>{
      clonedDoc.querySelectorAll('.teacher-watermark, .islamic-pattern').forEach(n=> n.remove());
      if(clonedDoc.body){ clonedDoc.body.style.background = '#ffffff'; }
      if(clonedDoc.documentElement){ clonedDoc.documentElement.style.background = '#ffffff'; }
      /* html2canvas ينسخ الصفحة داخل iframe منفصل داخليًا، وقد يكون تحميل الخطوط فيه غير
         متزامن مع الصفحة الأصلية حتى لو كانت جاهزة هناك، فتظهر الحروف العربية مفكّكة. بما أن
         html2canvas تنتظر أي Promise تُعيدها onclone قبل المتابعة، ننتظر هنا صراحةً اكتمال
         تحميل خطوط المستند المستنسخ نفسه، مع مهلة قصوى احترازية حتى لا يتعلّق التصدير للأبد. */
      if(clonedDoc.fonts && clonedDoc.fonts.ready){
        return Promise.race([
          clonedDoc.fonts.ready,
          new Promise(resolve=> setTimeout(resolve, 1500))
        ]);
      }
      return Promise.resolve();
    };

    async function captureWithScale(pageEl, scale){
      return html2canvas(pageEl, {
        scale,
        useCORS:true,
        allowTaint:true,
        backgroundColor:'#ffffff',
        logging:false,
        ignoreElements: ignoreFloatingBackgrounds,
        onclone: forceCleanClone
      });
    }

    try{
      await waitForPdfLibs();
      await ensureMindmapFontsLoaded();
      /* مهلة بسيطة إضافية لضمان اكتمال رسم العنصر (الخطوط والتخطيط) في DOM قبل التقاطه بالصورة */
      await new Promise(r=>setTimeout(r, 150));

      const pageEl = area.querySelector('.pp-page');

      /* حساب scale آمن حسب أبعاد المحتوى الفعلية، بحيث لا يتجاوز ناتج الـ canvas حدًا
         أقصى آمنًا (~4000px لأي بعد) وهو ما يتوافق مع أضعف متصفحات الجوّال */
      const naturalW = pageEl.scrollWidth || 794;
      const naturalH = pageEl.scrollHeight || 1123;
      const MAX_DIM = 4000;
      let scale = 2;
      if(naturalW*scale > MAX_DIM || naturalH*scale > MAX_DIM){
        scale = Math.max(1, Math.min(scale, MAX_DIM / Math.max(naturalW, naturalH)));
      }

      let canvas;
      try{
        canvas = await captureWithScale(pageEl, scale);
      }catch(innerErr){
        /* محاولة أخيرة أكثر أمانًا بحجم scale=1 إن فشلت المحاولة الأولى لأي سبب متعلق بالأبعاد */
        console.warn('exportMindmapPDF: retrying with scale=1 after error:', innerErr);
        canvas = await captureWithScale(pageEl, 1);
      }

      /* حارس أمان صريح: إن كان canvas بأبعاد صفرية أو غير سليمة (وهذا ما كان يسبب سابقًا
         خطأ "Invalid coordinates passed to jsPDF.addImage" بصمت) نوقف العملية برسالة
         عربية واضحة بدل تمرير قيم NaN/صفرية إلى jsPDF */
      if(!canvas || !canvas.width || !canvas.height){
        throw new Error('تعذّر تجهيز صورة الخريطة الذهنية (أبعاد فارغة). أعد فتح الدرس وحاول مجددًا.');
      }

      const imgData = canvas.toDataURL('image/jpeg', 0.95);

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();

      let imgWidth = pageWidth;
      let imgHeight = (canvas.height * imgWidth) / canvas.width;
      if(imgHeight > pageHeight){
        imgHeight = pageHeight;
        imgWidth = (canvas.width * imgHeight) / canvas.height;
      }
      const x = (pageWidth - imgWidth) / 2;
      const y = Math.max(0, (pageHeight - imgHeight) / 2);

      if(![x,y,imgWidth,imgHeight].every(Number.isFinite)){
        throw new Error('تعذّر حساب أبعاد ملف PDF بشكل صحيح. أعد فتح الدرس وحاول مجددًا.');
      }

      pdf.addImage(imgData, 'JPEG', x, y, imgWidth, imgHeight);
      pdf.save(`الخريطة الذهنية - ${lesson.title}.pdf`);
    }catch(err){
      console.error('exportMindmapPDF failed:', err);
      const msg = (err && err.message) ? err.message : 'تعذّر إنشاء ملف PDF. تأكد من اتصالك بالإنترنت ثم حاول مجددًا.';
      alert(msg);
    }finally{
      area.innerHTML = '';
      btn.innerHTML = originalBtnHTML;
      btn.disabled = false;
    }
  })();
}

/* ---------- الخريطة الذهنية ---------- */
function renderMindmap(lesson, wrap){
  if(!lesson.tree){ wrap.innerHTML=''; return; }
  wrap.innerHTML = lesson.tree.map(branch=>{
    const childrenHtml = (branch.children||[]).map(ch=>`
      <div class="mm-leaf">
        <span class="mm-leaf-title">${ch.title}</span>
        ${ch.rule?`<div class="mm-leaf-rule">${ch.rule}</div>`:''}
        ${ch.example?`<div class="mm-leaf-example">✏️ ${ch.example}</div>`:''}
      </div>`).join('');
    return `<details class="mm-branch c-${branch.color||'blue'}">
      <summary><span>${branch.title}</span><span class="chev">▾</span></summary>
      <div class="mm-branch-body">
        ${branch.rule?`<div class="mm-rule">${branch.rule}</div>`:''}
        ${branch.example?`<div class="mm-example">✏️ ${branch.example}</div>`:''}
        ${childrenHtml?`<div class="mm-children">${childrenHtml}</div>`:''}
      </div>
    </details>`;
  }).join('');
}

/* ---------- شاشة الوضعية الإدماجية ---------- */
let situationRendered = false;
function renderSituationScreen(){
  const s = window.SITUATION;
  if(!s) return;
  document.getElementById('situationDef').innerHTML = s.def || '';
  renderMindmap(s, document.getElementById('situationMindmap'));
  if(!situationRendered){
    document.getElementById('situationMindmapPdfBtn').onclick = ()=>
      exportMindmapPDF(s, document.getElementById('situationMindmapPdfBtn'));
    situationRendered = true;
  }
  Locks.load().then(renderSituationPracticeTabs);
}

/* ---------- تبويبات «وضعيات للاستئناس» حسب المقاطع الثمانية (يتحكم بفتحها/إغلاقها الأستاذ/المشرف) ---------- */
let situPracticeActiveKey = null;
let situActiveStoryId = null;
function renderSituationPracticeTabs(){
  const data = window.SITU_PRACTICE;
  const tabsWrap = document.getElementById('situPracticeTabs');
  if(!data || !data.length || !tabsWrap) return;

  if(!situPracticeActiveKey) situPracticeActiveKey = data[0].key;

  tabsWrap.innerHTML = data.map(seg => {
    const locked = Locks.isSituationLocked(seg.key);
    return `
    <button type="button" class="situ-tab ${seg.key === situPracticeActiveKey ? 'active' : ''} ${locked ? 'is-locked' : ''}" data-key="${seg.key}">
      <span class="situ-tab-num">${String(seg.num).padStart(2,'0')}</span>
      <span class="situ-tab-icon">${seg.icon}</span>
      <span class="situ-tab-label">${seg.title}</span>
      <span class="situ-tab-lock">${locked ? '🔒' : '🔓'}</span>
    </button>`;
  }).join('');

  tabsWrap.querySelectorAll('.situ-tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(situPracticeActiveKey === btn.getAttribute('data-key')){ renderSituationPracticePanel(); return; }
      situPracticeActiveKey = btn.getAttribute('data-key');
      situActiveStoryId = null;
      tabsWrap.querySelectorAll('.situ-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      btn.scrollIntoView({behavior:'smooth', inline:'center', block:'nearest'});
      renderSituationPracticePanel();
    });
  });

  renderSituationPracticePanel();
}

function renderSituationPracticePanel(){
  const data = window.SITU_PRACTICE;
  const panel = document.getElementById('situPracticePanel');
  if(!data || !data.length || !panel) return;
  stopStoryNarration();
  const seg = data.find(x => x.key === situPracticeActiveKey) || data[0];

  if(Locks.isSituationLocked(seg.key)){
    situActiveStoryId = null;
    panel.innerHTML = `
      <div class="exam-panel">
        <span class="lock-icon">🔒</span>
        سيُفتح هذا المقطع «${seg.title}» من قبل الأستاذ أو المشرف في الوقت المناسب
      </div>`;
    return;
  }

  /* مقاطع من نوع "قصص للقراءة" (عناوين تُفتح كل واحدة على حدة) */
  if(seg.stories && seg.stories.length){
    if(situActiveStoryId){
      const story = seg.stories.find(s => s.id === situActiveStoryId);
      if(story){ renderStoryReader(seg, story); return; }
    }
    renderStoryTitlesList(seg);
    return;
  }

  situActiveStoryId = null;
  panel.innerHTML = `
    <div class="situ-panel c-${seg.color || 'blue'}">
      <div class="situ-panel-head">
        <span class="situ-panel-icon"><span class="icon-glyph">${seg.icon}</span></span>
        <span class="situ-panel-title">المقطع ${seg.num}: ${seg.title}</span>
      </div>
      ${(seg.situations||[]).map(sit => `
        <div class="situ-card">
          <div class="situ-card-title">${sit.title}</div>
          <div class="situ-block">
            <span class="situ-block-label">🔹 السياق</span>
            <p class="situ-block-text">${sit.context}</p>
          </div>
          <div class="situ-block">
            <span class="situ-block-label">🔹 السند</span>
            <p class="situ-block-text">${sit.support}</p>
          </div>
          <div class="situ-block">
            <span class="situ-block-label">🔹 التعليمة</span>
            <p class="situ-block-text">${sit.instruction}</p>
          </div>
          ${sit.pattern ? `<div class="situ-pattern">🧭 النمط المقترح: <b>${sit.pattern}</b></div>` : ''}
        </div>`).join('')}
    </div>`;
}

/* ---------- قائمة عناوين القصص داخل مقطع (يُضغط على العنوان لفتح القصة كاملة) ---------- */
function renderStoryTitlesList(seg){
  const panel = document.getElementById('situPracticePanel');
  panel.innerHTML = `
    <div class="situ-panel c-${seg.color || 'blue'}">
      <div class="situ-panel-head">
        <span class="situ-panel-icon"><span class="icon-glyph">${seg.icon}</span></span>
        <span class="situ-panel-title">المقطع ${seg.num}: ${seg.title}</span>
      </div>
      <div class="story-hint">📖 اضغط على عنوان الوضعية لقراءتها كاملة</div>
      <div class="story-list">
        ${seg.stories.map(st => `
          <div class="story-list-item" data-story="${st.id}">
            <span class="story-list-icon"><span class="icon-glyph">${st.icon}</span></span>
            <span class="story-list-title">${st.title}</span>
            <span class="story-list-arrow">‹</span>
          </div>`).join('')}
      </div>
    </div>`;
  panel.querySelectorAll('.story-list-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      situActiveStoryId = item.getAttribute('data-story');
      renderSituationPracticePanel();
    });
  });
}

/* ---------- قارئ القصة الكاملة (بشكلها التام) + زر الاستماع بصوت حنون ---------- */
function renderStoryReader(seg, story){
  const panel = document.getElementById('situPracticePanel');
  const bodyHtml = story.blocks.map(b=>{
    if(b.type === 'quote') return `<div class="story-quote">${b.text}</div>`;
    if(b.type === 'moral') return `<div class="story-moral"><span class="story-moral-badge">🖊️ العبرة</span><p>${b.text}</p></div>`;
    if(b.type === 'scene') return `<div class="story-scene"><span class="story-scene-icon">${b.icon}</span><span class="story-scene-caption">${b.caption||''}</span></div>`;
    return `<p class="story-p">${b.text}</p>`;
  }).join('');

  panel.innerHTML = `
    <div class="situ-panel c-${seg.color || 'blue'}">
      <button type="button" class="story-back-btn" id="storyBackBtn">‹ رجوع إلى عناوين المقطع</button>
      <div class="story-reader">
        <div class="story-reader-head">
          <span class="story-reader-icon"><span class="icon-glyph">${story.icon}</span></span>
          <h3 class="story-reader-title">${story.title}</h3>
        </div>
        <button type="button" class="story-listen-btn" id="storyListenBtn">🔊 استمع إلى الوضعية</button>
        <div class="story-body" id="storyBody">${bodyHtml}</div>
      </div>
    </div>`;

  document.getElementById('storyBackBtn').addEventListener('click', ()=>{
    situActiveStoryId = null;
    renderSituationPracticePanel();
  });

  document.getElementById('storyListenBtn').addEventListener('click', (e)=>{
    if(storyNarrationActive){ stopStoryNarration(); return; }
    startStoryNarration(story, e.currentTarget);
  });
}

/* ---------- الاستماع للقصة بصوت حنون: قراءة متأنية، فقرة فقرة، مع وقفات هادئة ---------- */
let storyNarrationActive = false;
let storyNarrationQueue = [];
let storyNarrationIdx = 0;

function pickArabicVoice(){
  if(!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  return voices.find(v => /^ar/i.test(v.lang)) || null;
}

function startStoryNarration(story, btnEl){
  if(!('speechSynthesis' in window)){
    alert('عذرًا، متصفحك لا يدعم خاصية الاستماع الصوتي.');
    return;
  }
  window.speechSynthesis.cancel();
  storyNarrationQueue = story.blocks
    .map(b => (b.speech || b.caption || b.text || '').replace(/<[^>]+>/g, ''))
    .filter(t => t && t.trim());
  storyNarrationIdx = 0;
  storyNarrationActive = true;
  if(btnEl){ btnEl.textContent = '⏹ إيقاف الاستماع'; btnEl.classList.add('is-playing'); }
  speakNextBlock(btnEl);
}

function speakNextBlock(btnEl){
  if(!storyNarrationActive) return;
  if(storyNarrationIdx >= storyNarrationQueue.length){
    stopStoryNarration();
    return;
  }
  const text = storyNarrationQueue[storyNarrationIdx++];
  const utter = new SpeechSynthesisUtterance(text);
  const voice = pickArabicVoice();
  if(voice) utter.voice = voice;
  utter.lang = voice ? voice.lang : 'ar-SA';
  utter.rate = 0.82;   /* قراءة متأنية ليسهل الفهم */
  utter.pitch = 1.08;  /* نبرة أكثر دفئًا وحنوًا */
  utter.volume = 1;
  utter.onend = ()=>{ setTimeout(()=> speakNextBlock(btnEl), 380); /* وقفة هادئة بين الفقرات */ };
  utter.onerror = ()=> stopStoryNarration();
  window.speechSynthesis.speak(utter);
}

function stopStoryNarration(){
  storyNarrationActive = false;
  storyNarrationQueue = [];
  storyNarrationIdx = 0;
  if('speechSynthesis' in window) window.speechSynthesis.cancel();
  const btn = document.getElementById('storyListenBtn');
  if(btn){ btn.textContent = '🔊 استمع إلى الوضعية'; btn.classList.remove('is-playing'); }
}

/* ---------- شاشة الفروض والاختبارات ---------- */
function renderExamsScreen(){
  Promise.all([Locks.load(), ExamLinks.load()]).then(()=>{
    const trimesters = [
      {key:'t1', icon:'📘', label:'الفصل الأول'},
      {key:'t2', icon:'📗', label:'الفصل الثاني'},
      {key:'t3', icon:'📙', label:'الفصل الثالث'}
    ];
    const tabsWrap = document.getElementById('examTabsWrap');
    tabsWrap.innerHTML = trimesters.map((t,i)=>{
      const open = Locks.isTrimesterOpen(t.key);
      return `<div class="exam-tab ${i===0?'active':''}" data-t="${t.key}"><span class="et-icon">${t.icon}</span>${t.label}<span class="lock-mini">${open?'🔓 مفتوح':'🔒 مغلق'}</span></div>`;
    }).join('');
    const panel = document.getElementById('examPanelWrap');
    function showPanel(t){
      const open = Locks.isTrimesterOpen(t);
      if(!open){
        panel.innerHTML = `<div class="exam-panel"><span class="lock-icon">🔒</span>سيُفتح هذا القسم من قبل الأستاذ أو المشرف في الوقت المناسب</div>`;
        return;
      }
      const items = ExamLinks.getItems(t);
      if(!items.length){
        panel.innerHTML = `<div class="exam-panel">📋 سيظهر هنا محتوى فروض واختبارات هذا الفصل عند رفعه من الأستاذ/المشرف.</div>`;
        return;
      }
      const trimesterLabel = trimesters.find(x=> x.key===t).label;
      panel.innerHTML = `<div class="zoom-docs-row" style="flex-direction:column;align-items:stretch;gap:10px">${
        items.map(it=>
          `<a class="zoom-doc-btn" href="${escZoomText(it.link)}" target="_blank" rel="noopener">📝 ${escZoomText(it.title || 'فتح الفرض/الاختبار')}</a>`
        ).join('')
      }</div>` + buildExamSolutionInlineHtml(items.length > 0);
      wireExamSolutionInline(panel, t, trimesterLabel);
    }
    tabsWrap.querySelectorAll('.exam-tab').forEach(tab=>{
      tab.addEventListener('click', ()=>{
        tabsWrap.querySelectorAll('.exam-tab').forEach(x=>x.classList.remove('active'));
        tab.classList.add('active'); showPanel(tab.getAttribute('data-t'));
      });
    });
    showPanel('t1');
  });
}

/* ---------- تحديث بادج القفل على بطاقة "إعراب الجمل" في الصفحة الرئيسية ---------- */
function updateIrabHomeCardLock(){
  const badge = document.getElementById('irabHomeLockBadge');
  if(!badge) return;
  badge.style.display = Locks.isIrabOpen() ? 'none' : 'block';
}

/* ---------- شاشة إعراب الجمل ---------- */
function renderIrabScreen(){
  const wrap = document.getElementById('irabContentWrap');
  wrap.innerHTML = '<div class="sf-label">جاري التحميل…</div>';
  Locks.load().then(()=>{
    if(!Locks.isIrabOpen()){
      wrap.innerHTML = `
        <div class="exam-panel" style="text-align:center">
          🔒 <b>قسم إعراب الجمل مغلق حاليًا</b>
          <div class="sf-label" style="margin-top:8px">سيقوم الأستاذ بفتحه لاحقًا — تابع الإشعارات.</div>
        </div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="irab-launch" id="irabLaunch1"><div class="il-icon"><span class="icon-glyph">📗</span></div><div>
        <div class="il-title">إعراب 101 جملة وجملة</div>
        <div class="il-sub">أجب شفهيًا عن كل جملة، وسأتحقق تلقائيًا من إعرابك</div></div></div>
      <div class="irab-launch" id="irabLaunch2"><div class="il-icon"><span class="icon-glyph">📙</span></div><div>
        <div class="il-title">الاختبار الشامل الثاني</div>
        <div class="il-sub">تدريبات إضافية على الجمل التي لها محلّ من الإعراب</div></div></div>
      <div id="irabEngineMount"></div>`;
    document.getElementById('irabLaunch1').addEventListener('click', ()=>{
      createIrabEngine(window.EXAM_FULL2, document.getElementById('irabEngineMount'), 'إعراب 101 جملة');
    });
    document.getElementById('irabLaunch2').addEventListener('click', ()=>{
      createIrabEngine(window.EXAM_FULL, document.getElementById('irabEngineMount'), 'الاختبار الشامل');
    });
  });
}

/* ---------- شاشة الترتيب العام ----------
   ثلاثة أقسام مستقلة تمامًا عن بعضها:
   1) لوحة الشرف العامة: ترتيب شامل لكل التلاميذ بمجموع نتائجهم في كل تمارين الدروس مجتمعة.
   2) ترتيب الفروض والاختبارات: ترتيب مستقل بمجموع النقاط المتحصل عليها في الفروض/الاختبارات المنجزة فقط.
   3) ترتيب تمارين كل درس على حدة: تبقى كما كانت — نافذة منبثقة خاصة بكل درس عند الضغط عليه. */
function renderLeaderboardScreen(){
  const wrap = document.getElementById('leaderboardWrap');
  wrap.innerHTML = `
    <div class="lb-mystats-section" id="lbMyStatsSection" style="display:none">
      <div class="lb-section-title" style="border-bottom:none;padding-bottom:0;margin-bottom:10px">
        <span class="lb-section-icon"><span class="icon-glyph">📊</span></span>نتائجك الإجمالية
      </div>
      <div class="sf-label" style="margin-bottom:10px">مجموع نقاط تمارين الدروس + الفروض والاختبارات معًا</div>
      <div class="lb-mystats-row">
        <div class="lb-mystat-card">
          <div class="lb-mystat-value" id="lbMyPoints">—</div>
          <div class="lb-mystat-label">مجموع نقاطك</div>
        </div>
        <div class="lb-mystat-card">
          <div class="lb-mystat-value" id="lbMyRank">—</div>
          <div class="lb-mystat-label">ترتيبك العام</div>
        </div>
        <div class="lb-mystat-card">
          <div class="lb-mystat-value" id="lbMyTotalStudents">—</div>
          <div class="lb-mystat-label">مجموع التلاميذ</div>
        </div>
      </div>
    </div>

    <div class="lb-main-grid">
      <div class="lb-main-card" id="lbOpenHall">
        <div class="lb-main-icon"><span class="icon-glyph">🏅</span></div>
        <div class="lb-main-title">لوحة الشرف العامة</div>
        <div class="lb-main-desc">ترتيب شامل لكل التلاميذ بمجموع نتائجهم الإجمالية في تمارين الدروس المنجزة</div>
      </div>

      <div class="lb-main-card" id="lbOpenExams">
        <div class="lb-main-icon"><span class="icon-glyph">📝</span></div>
        <div class="lb-main-title">ترتيب الفروض والاختبارات</div>
        <div class="lb-main-desc">ترتيب مستقل بمجموع النقاط المتحصَّل عليها في الفروض والاختبارات والتمارين اليومية المنجزة</div>
      </div>

      <div class="lb-main-card" id="lbOpenLessons">
        <div class="lb-main-icon"><span class="icon-glyph">📚</span></div>
        <div class="lb-main-title">ترتيب تمارين كل درس</div>
        <div class="lb-main-desc">اختر درسًا من القائمة أدناه لعرض ترتيب تمارينه الخاصة به في نافذة مستقلة</div>
      </div>
    </div>

    <div class="lb-section">
      <div id="lbLessonGrid" class="lb-lesson-grid"></div>
    </div>`;

  document.getElementById('lbOpenHall').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    showOverallLeaderboardPopup();
  });
  document.getElementById('lbOpenExams').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    showExamsLeaderboardPopup();
  });
  document.getElementById('lbOpenLessons').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    document.getElementById('lbLessonGrid').scrollIntoView({ behavior:'smooth', block:'start' });
  });

  loadMyOverallStats(); /* بطاقة نقاطك/ترتيبك/عدد التلاميذ — مجموع كل الدروس، لا درس بعينه */

  /* 3) شبكة الدروس — تُعرض فقط الدروس المفتوحة حاليًا من طرف الأستاذ (وليس كل الدروس بغضّ النظر
     عن حالة القفل)، حتى لا يرى التلميذ ترتيب درس لم يُفتح له بعد.
     تُستبعد أيضًا سلسلة "المكتسبات القبلية" (category:'muktasabat') ودروس zoomOnly، لأنها بلا
     تمارين حقيقية أصلاً (نفس الاستثناء المطبَّق في openLessonDetail على بطاقة "ترتيب تلاميذ هذا
     الدرس")، فلا داعي لظهورها هنا في قائمة اختيار الدروس */
  const grid = document.getElementById('lbLessonGrid');
  window.LESSONS.filter(l=> l.locked!=='pending' && !Locks.isLessonLocked(l.id) && l.category!=='muktasabat' && !l.zoomOnly).forEach(l=>{
    const card = document.createElement('div');
    card.className = 'lb-lesson-card';
    card.innerHTML = `
      <div class="lb-card-num">د${String(l.order).padStart(2,'0')}</div>
      <div class="lb-card-icon"><span class="icon-glyph">🏆</span></div>
      <div class="lb-card-title">${l.title}</div>`;
    card.addEventListener('click', ()=> showLeaderboardPopup(l));
    grid.appendChild(card);
  });
}

/* ---------- بطاقة "نتائجك الإجمالية" أعلى شاشة الترتيب: نقاط التلميذ ومرتبته العامة (مجموع كل
   الدروس، وليس درسًا بعينه) وعدد كل تلاميذ المنصة. تُخفى كليًا إن لم يكن هناك تلميذ مسجَّل دخوله
   أو إن تعذّر الوصول لقاعدة البيانات ---------- */
async function loadMyOverallStats(){
  const section = document.getElementById('lbMyStatsSection');
  if(!section || !fbReady || !Student.id) return;
  try{
    const cache = await Leaderboard.refreshIfStale(); // قراءة واحدة عادةً، أو إعادة حساب كاملة نادرًا (مرة كل 24 س)
    const pointsEl = document.getElementById('lbMyPoints');
    const rankEl = document.getElementById('lbMyRank');
    const totalEl = document.getElementById('lbMyTotalStudents');
    if(!pointsEl || !rankEl || !totalEl) return; /* المستخدم غادر الشاشة قبل انتهاء التحميل */
    /* مرتبة التلميذ ونقاطه تصلان جاهزتين من مستنده الشخصي (Student.combinedRank/combinedScore)
       الذي يراقبه أصلاً باستمرار — بلا أي قراءة إضافية */
    pointsEl.textContent = (typeof Student.combinedScore === 'number') ? Math.round(Student.combinedScore) : '0';
    rankEl.textContent = Student.combinedRank ? `#${Student.combinedRank}` : '—';
    totalEl.textContent = (cache && cache.totalStudents) || '—';
    section.style.display = '';
  }catch(e){ console.error('تعذّر تحميل بطاقة نتائجك الإجمالية:', e); }
}

function renderHallRow(idx, rankLabel, nameHtml, metaHtml, badgeHtml){
  const rankCls = idx===0?'first':idx===1?'second':idx===2?'third':'';
  const trophy = idx===0?'🥇':idx===1?'🥈':idx===2?'🥉':'';
  return `<div class="lb-hall-item">
      <div class="lb-hall-rank ${rankCls}">${trophy || rankLabel}</div>
      <div class="lb-hall-info">
        <div class="lb-hall-name">${nameHtml}</div>
        <div class="lb-hall-meta">${metaHtml}</div>
      </div>
      <div class="lb-hall-badge">${badgeHtml}</div>
    </div>`;
}

/* ===== Popups الكاملة (النوافذ المنبثقة) ===== */
async function showOverallLeaderboardPopup(){
  if(!fbReady){
    alert('Firebase غير مفعّل. لا يمكن عرض الترتيب.');
    return;
  }
  
  const overlay = document.createElement('div');
  overlay.className = 'leaderboard-modal-overlay';
  
  const popup = document.createElement('div');
  popup.className = 'leaderboard-modal-popup';
  
  const header = document.createElement('div');
  header.className = 'leaderboard-modal-header';
  
  const title = document.createElement('div');
  title.className = 'leaderboard-modal-title';
  title.textContent = '🏅 لوحة الشرف العامة';
  
  const subtitle = document.createElement('div');
  subtitle.className = 'leaderboard-modal-subtitle';
  subtitle.textContent = 'أفضل 10 تلاميذ — ومرتبتك أنت';
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'leaderboard-modal-close';
  closeBtn.innerHTML = '✕';
  closeBtn.onclick = ()=>overlay.remove();
  
  header.appendChild(title);
  header.appendChild(subtitle);
  header.appendChild(closeBtn);
  
  const listDiv = document.createElement('div');
  listDiv.className = 'leaderboard-modal-list';
  listDiv.innerHTML = '<div class="leaderboard-empty" style="padding:30px 20px;">جاري تحميل الترتيب…</div>';
  
  popup.appendChild(header);
  popup.appendChild(listDiv);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  
  try{
    const cache = await Leaderboard.refreshIfStale(); // قراءة واحدة عادةً؛ إعادة حساب كاملة نادرًا (كل 24 س)
    const results = (cache && cache.top10Lessons) || [];
    if(!results.length){
      listDiv.innerHTML = '<div class="leaderboard-empty" style="padding:30px 20px;">لا توجد نتائج بعد</div>';
      return;
    }
    
    let html = results.map((r, idx)=> renderHallRow(
      idx, (idx+1),
      r.name,
      `مجموع النتائج: ${r.totalScore} — ${r.exercisesCount} تمرين منجز`,
      `${r.avgPercent}%`
    )).join('');
    /* صفّ إضافي يعرض مرتبة التلميذ الحالي هو، إن لم يكن أصلاً ضمن العشرة الأوائل */
    const inTop10 = results.some(r=> r.studentId === Student.id);
    if(!inTop10 && Student.id && Student.lessonsRank){
      html += `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #ccc;"></div>` +
        renderHallRow(-1, `#${Student.lessonsRank}`, `${Student.fullName} (أنت)`,
          `مجموع النتائج: ${Student.lessonsScore||0}`, '');
    }
    listDiv.innerHTML = html;
  }catch(e){
    console.error('Error loading overall leaderboard popup:', e);
    listDiv.innerHTML = '<div class="leaderboard-empty" style="padding:30px 20px;">خطأ في تحميل الترتيب</div>';
  }
}

async function showExamsLeaderboardPopup(){
  if(!fbReady){
    alert('Firebase غير مفعّل. لا يمكن عرض الترتيب.');
    return;
  }
  
  const overlay = document.createElement('div');
  overlay.className = 'leaderboard-modal-overlay';
  
  const popup = document.createElement('div');
  popup.className = 'leaderboard-modal-popup';
  
  const header = document.createElement('div');
  header.className = 'leaderboard-modal-header';
  
  const title = document.createElement('div');
  title.className = 'leaderboard-modal-title';
  title.textContent = '📝 ترتيب الفروض والاختبارات';
  
  const subtitle = document.createElement('div');
  subtitle.className = 'leaderboard-modal-subtitle';
  subtitle.textContent = 'أفضل 10 تلاميذ في الفروض والاختبارات — ومرتبتك أنت';
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'leaderboard-modal-close';
  closeBtn.innerHTML = '✕';
  closeBtn.onclick = ()=>overlay.remove();
  
  header.appendChild(title);
  header.appendChild(subtitle);
  header.appendChild(closeBtn);
  
  const listDiv = document.createElement('div');
  listDiv.className = 'leaderboard-modal-list';
  listDiv.innerHTML = '<div class="leaderboard-empty" style="padding:30px 20px;">جاري تحميل الترتيب…</div>';
  
  popup.appendChild(header);
  popup.appendChild(listDiv);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  
  try{
    const cache = await Leaderboard.refreshIfStale(); // قراءة واحدة عادةً؛ إعادة حساب كاملة نادرًا (كل 24 س)
    const results = (cache && cache.top10Exams) || [];
    if(!results.length){
      listDiv.innerHTML = '<div class="leaderboard-empty" style="padding:30px 20px;">لا توجد فروض أو اختبارات منجزة بعد</div>';
      return;
    }
    
    let html = results.map((r, idx)=> renderHallRow(
      idx, (idx+1),
      r.name,
      `${r.examsCount} فرض/اختبار منجز`,
      `${r.totalPoints} نقطة`
    )).join('');
    const inTop10 = results.some(r=> r.studentId === Student.id);
    if(!inTop10 && Student.id && Student.examsRank){
      html += `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #ccc;"></div>` +
        renderHallRow(-1, `#${Student.examsRank}`, `${Student.fullName} (أنت)`,
          `${Student.examsPoints||0} نقطة`, '');
    }
    listDiv.innerHTML = html;
  }catch(e){
    console.error('Error loading exams leaderboard popup:', e);
    listDiv.innerHTML = '<div class="leaderboard-empty" style="padding:30px 20px;">خطأ في تحميل الترتيب</div>';
  }
}

/* ---------- موسكوت SVG (نفس تصميم المعاينة) ---------- */
const MASCOT_SVG = `<svg class="mascot" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="50" cy="58" rx="34" ry="30" fill="#F3ECD5" stroke="#A97F2A" stroke-width="2.2"/>
  <path d="M20 40 Q50 8 80 40 Q68 30 50 30 Q32 30 20 40Z" fill="#3F6350" stroke="#A97F2A" stroke-width="2"/>
  <rect x="42" y="14" width="16" height="6" rx="1" fill="#22352B"/><circle cx="58" cy="16" r="2.2" fill="#D8AE52"/>
  <circle cx="36" cy="55" r="12" fill="#FFFDF7" stroke="#A97F2A" stroke-width="2"/>
  <circle cx="64" cy="55" r="12" fill="#FFFDF7" stroke="#A97F2A" stroke-width="2"/>
  <circle cx="37" cy="56" r="4.6" fill="#22352B"/><circle cx="63" cy="56" r="4.6" fill="#22352B"/>
  <circle cx="38.5" cy="54" r="1.4" fill="#FFFDF7"/><circle cx="64.5" cy="54" r="1.4" fill="#FFFDF7"/>
  <path d="M46 68 L50 74 L54 68Z" fill="#D8AE52"/>
  <path d="M18 68 Q10 66 14 78 Q22 76 24 70Z" fill="#F3ECD5" stroke="#A97F2A" stroke-width="1.6"/>
  <path d="M82 68 Q90 66 86 78 Q78 76 76 70Z" fill="#F3ECD5" stroke="#A97F2A" stroke-width="1.6"/>
</svg>`;

/* =========================================================================================
   لوحة تحكم الأستاذ/المشرف
   ========================================================================================= */

/* ===== نظام الأقسام القابلة للطي (Accordion) في لوحة تحكم الأستاذ =====
   يحتفظ بمجموعة معرّفات الأقسام المفتوحة حاليًا في هذا المتغيّر (خارج أي دالة) كي تبقى
   الأقسام المفتوحة مفتوحة حتى بعد إعادة رسم اللوحة (renderAdminPanel) عند كل تفاعل. */
const AdminAccordionState = { open: new Set() };

/* أيقونات مصغّرة مجسّمة (نفس طراز بطاقات الشاشة الرئيسية) لعناوين أقسام لوحة تحكم الأستاذ.
   كل دالة تُعيد <span> يحوي إطارًا ذهبيًا بخلفية أرابيسك + أيقونة SVG واقعية بالداخل. */
/* ثلاث تدرّجات ألوان تُستعمل بالتناوب لإطارات الأيقونات — بنفس أسلوب البطاقات العريضة
   (إدارة حصص الزوم/الفروض/الحلول) حتى تتّسق جميع أقسام لوحة الأستاذ بصريًا */
const AA_BG_GOLD  = 'linear-gradient(150deg,#FBEDC3,#E7C878)';
const AA_BG_TAN   = 'linear-gradient(150deg,#F0E6D6,#D8AE52)';
const AA_BG_GREEN = 'linear-gradient(150deg,#D9EAD9,#8FC98F)';
function aaIcon(svgInner, bg){
  return `<span class="aa-icon-wrap" style="background:${bg || AA_BG_GOLD}"><svg class="aa-svg-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${svgInner}</svg></span>`;
}
const AA_ICONS = {
  /* ⏳ طلبات الانتظار — ساعة رملية ذهبية */
  pending: aaIcon(`
    <path d="M16 8 H48 V16 C48 24 40 28 32 32 C40 36 48 40 48 48 V56 H16 V48 C16 40 24 36 32 32 C24 28 16 24 16 16 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M20 12 H44 C44 19 38 23 32 26 C26 23 20 19 20 12 Z" fill="url(#hcCream)" opacity="0.9"/>
    <path d="M20 52 H44 C44 45 38 41 32 38 C26 41 20 45 20 52 Z" fill="url(#hcSageGem)" opacity="0.9"/>
    <rect x="13" y="5" width="38" height="5" rx="2.5" fill="url(#hcGoldDark)" stroke="#5C3D0F" stroke-width="0.8"/>
    <rect x="13" y="54" width="38" height="5" rx="2.5" fill="url(#hcGoldDark)" stroke="#5C3D0F" stroke-width="0.8"/>`, AA_BG_GOLD),
  /* 👥 التلاميذ المقبولون — شخصان متداخلان */
  approved: aaIcon(`
    <circle cx="23" cy="21" r="9.5" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1.2"/>
    <path d="M8 51 C8 38 14.5 32 23 32 C31.5 32 38 38 38 51 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1.2"/>
    <circle cx="43" cy="26" r="7.8" fill="url(#hcSageGem)" stroke="#2E4A34" stroke-width="1.1"/>
    <path d="M29 53 C29 43 34.5 38.5 43 38.5 C51.5 38.5 57 43 57 53 Z" fill="url(#hcSageGem)" stroke="#2E4A34" stroke-width="1.1" opacity="0.96"/>`, AA_BG_GREEN),
  /* 📖 فتح/إغلاق الدروس — نفس كتاب الشاشة الرئيسية */
  lessons: aaIcon(`
    <path d="M14 16 L50 12 L52 50 L16 54 Z" fill="url(#hcCream)" stroke="#D8AE52" stroke-width="1"/>
    <path d="M10 14 L46 9 L48 47 L12 51 Z" fill="url(#hcMaroonCover)" stroke="#2B0D08" stroke-width="1"/>
    <path d="M10 14 L15 14.6 L17 49 L12 51 Z" fill="#A0472C" opacity="0.55"/>
    <circle cx="29" cy="31" r="8" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1"/>
    <path d="M29 24.5 L31 29 L36 29.3 L32.3 32.3 L33.6 37 L29 34.2 L24.4 37 L25.7 32.3 L22 29.3 L27 29 Z" fill="#7A5216" opacity="0.85"/>`, AA_BG_TAN),
  /* 📝 فتح/إغلاق الفروض والاختبارات — نفس ورقة+قلم إدارة الروابط */
  exams: aaIcon(`
    <rect x="13" y="9" width="30" height="40" rx="3" fill="url(#hcCream)" stroke="#D8AE52" stroke-width="1"/>
    <rect x="23" y="5" width="10" height="8" rx="2" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
    <path d="M18 21 L38 21 M18 27 L38 27 M18 33 L31 33" stroke="#8A6A2A" stroke-width="1.4" opacity="0.6"/>
    <path d="M19 47 C29 40 39 32 49 20 L54 25 C44 37 34 45 24 52 Z" fill="url(#hcWood)" stroke="#241708" stroke-width="1"/>
    <path d="M49 20 L54 25 L57 22 C58.5 20.5 58.5 18.5 57 17 C55.5 15.5 53.5 15.5 52 17 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>`, AA_BG_GOLD),
  /* 📝 فتح/إغلاق وضعيات الاستئناس — نفس قطعتي الأحجية */
  situations: aaIcon(`
    <path d="M12 12 h16 c0,-3.5 2.8,-6 6,-6 c3.2,0 6,2.5 6,6 h4 v16 c3.5,0 6,2.8 6,6 c0,3.2 -2.5,6 -6,6 v14 h-16 c0,3.5 -2.8,6 -6,6 c-3.2,0 -6,-2.5 -6,-6 h-10 v-16 c-3.5,0 -6,-2.8 -6,-6 c0,-3.2 2.5,-6 6,-6 v-14 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1.2" stroke-linejoin="round" transform="translate(-4,2) scale(0.86)"/>
    <path d="M30 30 h16 c0,-3.5 2.8,-6 6,-6 c3.2,0 6,2.5 6,6 h4 v16 c3.5,0 6,2.8 6,6 c0,3.2 -2.5,6 -6,6 v14 h-16 c0,3.5 -2.8,6 -6,6 c-3.2,0 -6,-2.5 -6,-6 h-10 v-16 c-3.5,0 -6,-2.8 -6,-6 c0,-3.2 2.5,-6 6,-6 v-14 Z" fill="url(#hcSageGem)" stroke="#2E4A34" stroke-width="1.2" stroke-linejoin="round" transform="translate(-16,-16) scale(0.56)"/>
    <circle cx="34" cy="34" r="5.5" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1"/>`, AA_BG_GREEN),
  /* ✍️ فتح/إغلاق إعراب الجمل — نفس قلم الشاشة الرئيسية */
  irab: aaIcon(`
    <path d="M12 50 C22 40 34 28 46 15 L51 20 C39 32 27 44 17 54 Z" fill="url(#hcWood)" stroke="#241708" stroke-width="1"/>
    <path d="M46 15 L51 20 L54 17 C55.5 15.5 55.5 13.5 54 12 C52.5 10.5 50.5 10.5 49 12 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
    <path d="M12 50 L17 54 L14 58 C13 59 11 58.6 11 57 Z" fill="#1D1408"/>
    <path d="M11 58 C 18 52, 24 50, 34 52 C 26 54, 20 57, 16 62" fill="none" stroke="url(#hcGoldMetal)" stroke-width="1.6" stroke-linecap="round" opacity="0.9"/>`, AA_BG_TAN),
  /* 🧠 المعلّم الذكي — جوهرة متألقة ترمز للذكاء الاصطناعي */
  aiTeacher: aaIcon(`
    <path d="M32 6 L50 22 L42 54 L22 54 L14 22 Z" fill="url(#hcSageGem)" stroke="#2E4A34" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M32 6 L50 22 L32 30 L14 22 Z" fill="url(#hcGoldMetal)" opacity="0.88"/>
    <path d="M32 30 L35 38 L44 38 L37 43 L39 51 L32 46 L25 51 L27 43 L20 38 L29 38 Z" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="0.8" opacity="0.95"/>`, AA_BG_GOLD),
  /* 📊 إحصائيات كل درس — أعمدة بيانية متدرجة الطول */
  stats: aaIcon(`
    <rect x="10" y="34" width="10" height="22" rx="2" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
    <rect x="27" y="22" width="10" height="34" rx="2" fill="url(#hcSageGem)" stroke="#2E4A34" stroke-width="1"/>
    <rect x="44" y="10" width="10" height="46" rx="2" fill="url(#hcGoldDark)" stroke="#5C3D0F" stroke-width="1"/>
    <circle cx="49" cy="10" r="4.4" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="0.8"/>`, AA_BG_GREEN),
  /* 🧑 تلميذ واحد — لصورة رمزية في بطاقات طلبات الانتظار وقوائم التلاميذ المقبولين */
  singleStudent: aaIcon(`
    <circle cx="32" cy="24" r="12" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1.3"/>
    <path d="M12 56 C12 40 20 33 32 33 C44 33 52 40 52 56 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1.3"/>`, AA_BG_TAN),
  /* ❓ أسئلة التلاميذ (الدردشة) — فقاعة حوار */
  chat: aaIcon(`
    <path d="M8 14 C8 10 11 8 15 8 H49 C53 8 56 10 56 14 V38 C56 42 53 44 49 44 H26 L14 54 V44 H15 C11 44 8 42 8 38 Z" fill="url(#hcCream)" stroke="#D8AE52" stroke-width="1.2"/>
    <circle cx="21" cy="26" r="3.4" fill="#7A5216"/>
    <circle cx="32" cy="26" r="3.4" fill="#7A5216"/>
    <circle cx="43" cy="26" r="3.4" fill="#7A5216"/>`, AA_BG_GOLD),
  /* 📆 تمارين يومية — تقويم ذهبي */
  dailyExercises: aaIcon(`
    <rect x="10" y="14" width="44" height="40" rx="5" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1.3"/>
    <rect x="10" y="14" width="44" height="10" rx="5" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1"/>
    <rect x="16" y="8" width="4" height="10" rx="2" fill="#7A5216"/>
    <rect x="44" y="8" width="4" height="10" rx="2" fill="#7A5216"/>
    <rect x="17" y="30" width="8" height="8" rx="1.5" fill="#FFF6DE" opacity="0.9"/>
    <rect x="28" y="30" width="8" height="8" rx="1.5" fill="#FFF6DE" opacity="0.9"/>
    <rect x="39" y="30" width="8" height="8" rx="1.5" fill="#FFF6DE" opacity="0.9"/>
    <rect x="17" y="41" width="8" height="8" rx="1.5" fill="#FFF6DE" opacity="0.9"/>
    <path d="M31 43 l2.4 2.5 L38 40.5" fill="none" stroke="#3F6350" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`, AA_BG_GOLD)
};

function adminAccordionHTML(id, titleHtml, bodyHtml){
  const isOpen = AdminAccordionState.open.has(id);
  return `<div class="admin-accordion" data-accordion-id="${id}">
    <button type="button" class="admin-accordion-header" data-accordion-toggle="${id}" aria-expanded="${isOpen}">
      <span class="aa-title">${titleHtml}</span>
      <span class="aa-chevron">▾</span>
    </button>
    <div class="admin-accordion-body-wrap ${isOpen ? 'open' : ''}">
      <div class="admin-accordion-body-inner">${bodyHtml}</div>
    </div>
  </div>`;
}

/* تُستدعى بعد إدراج HTML الأقسام في الصفحة لتفعيل أزرار الفتح/الإغلاق داخل الحاوية المُعطاة */
function wireAdminAccordions(container){
  container.querySelectorAll('[data-accordion-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-accordion-toggle');
      const bodyWrap = btn.nextElementSibling;
      const nowOpen = !bodyWrap.classList.contains('open');
      bodyWrap.classList.toggle('open', nowOpen);
      btn.setAttribute('aria-expanded', String(nowOpen));
      if(nowOpen) AdminAccordionState.open.add(id); else AdminAccordionState.open.delete(id);
    });
  });
}

function setupAdminLoginModal(){
  const modal = document.getElementById('adminLoginModal');
  const input = document.getElementById('adminPinInput');
  document.getElementById('adminPinSubmit').addEventListener('click', ()=>{
    if(Admin.checkPin(input.value.trim())){
      modal.classList.remove('show'); input.value='';
      /* إخفاء نافذة تسجيل دخول التلميذ إن كانت ظاهرة، فهي تحجب لوحة تحكم الأستاذ/المشرف */
      document.getElementById('loginModal').classList.remove('show');
      /* الاستماع اللحظي لطلبات التسجيل يبدأ هنا فقط، بعد التحقق من هوية الأستاذ — وليس لأي زائر */
      Admin.listenPending(()=>{
        if(Admin.authed && document.getElementById('screen-admin').style.display !== 'none') renderAdminPanel();
      });
      Screens.show('admin'); renderAdminPanel();
    } else {
      alert('الرقم السري غير صحيح.');
    }
  });
  document.getElementById('adminLoginClose').addEventListener('click', ()=> modal.classList.remove('show'));
}

/* =========================================================================================
   💬 الدردشة العامة + أسئلة موجَّهة للأستاذ (الوسم #الاستاذ)
   - كل رسالة تُحفظ في مجموعة Firestore واحدة: chatMessages
   - إن احتوت الرسالة على #الاستاذ تُعتبر "سؤالًا" وتظهر للتلميذ بانتظار الرد،
     وتظهر فورًا في لوحة الأستاذ ضمن "أسئلة التلاميذ" (بث لحظي onSnapshot)
   - جواب الأستاذ (نص أو تسجيل صوتي عبر Firebase Storage) يظهر بعدها مباشرة
     في الدردشة العامة للجميع، مع اسم وسؤال التلميذ السائل
   ========================================================================================= */
const CHAT_TAG = '#الاستاذ';

const Chat = {
  _listening: false,
  _lastCount: 0,

  ensureListening(){
    if(this._listening || !auxFbReady()) return;
    this._listening = true;
    auxDb().collection('chatMessages').orderBy('createdAt','asc').limitToLast(200)
      .onSnapshot(snap=>{
        const msgs = snap.docs.map(d=>({ id:d.id, ...d.data() }));
        this._lastCount = msgs.length;
        this.renderMessages(msgs);
        this.updateMyAnswerBanner(msgs);
      }, err=>{
        console.error('خطأ في تحميل رسائل الدردشة (تحقق من قواعد Firestore لمجموعة chatMessages):', err);
        if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('chatMessages');
        const wrap = document.getElementById('chatMessagesWrap');
        if(wrap) wrap.innerHTML = '<div class="chat-pending-note">تعذّر تحميل الدردشة حاليًا.</div>';
      });
  },

  renderMessages(msgs){
    const wrap = document.getElementById('chatMessagesWrap');
    if(!wrap) return; /* الشاشة ليست في DOM (لا يحدث فعليًا لأن الشاشات تبقى مخفية فقط) */
    msgs = msgs.filter(m=>!m.hidden); /* الأسئلة التي حذفها الأستاذ لا تظهر إطلاقًا للتلميذ */
    if(!msgs.length){
      wrap.innerHTML = '<div class="chat-pending-note">لا توجد رسائل بعد — كن أول من يكتب!</div>';
      return;
    }
    wrap.innerHTML = msgs.map(m=>{
      const own = Student.id && m.studentId === Student.id;
      const name = escZoomText(m.studentName || 'تلميذ');
      const text = escZoomText(m.text || '');
      if(m.isQuestion){
        let html = `<div class="chat-msg chat-question ${own?'own':''}">
          <span class="chat-question-tag">❓ سؤال موجّه للأستاذ</span>
          <div class="chat-msg-name">${name}</div>
          <div class="chat-msg-text">${text}</div>
        </div>`;
        if(m.answered){
          const answerBody = m.answerAudioUrl
            ? `<audio controls src="${escZoomText(m.answerAudioUrl)}"></audio>`
            : `<div class="chat-msg-text">${escZoomText(m.answerText || '')}</div>`;
          html += `<div class="chat-answer">
            <div class="chat-answer-label">🎓 جواب الأستاذ على سؤال ${name}</div>
            ${answerBody}
          </div>`;
        } else {
          html += `<div class="chat-pending-note">⏳ بانتظار رد الأستاذ…</div>`;
        }
        return html;
      }
      return `<div class="chat-msg ${own?'own':''}">
        <div class="chat-msg-name">${name}</div>
        <div class="chat-msg-text">${text}</div>
      </div>`;
    }).join('');
    wrap.scrollTop = wrap.scrollHeight;
  },

  /* بطاقة ثابتة أسفل نافذة الدردشة (فوق خانة الكتابة) تُظهر آخر جواب على سؤال التلميذ
     الحالي فقط — بلا حاجة للتمرير بين كل الرسائل، حتى لا يضيع جوابه وسط كثرة الأسئلة.
     تختفي عند الضغط على ✕ (يُحفظ معرّف آخر جواب أُخفي في localStorage)، وتظهر تلقائيًا
     من جديد إن وصل جواب أحدث. */
  updateMyAnswerBanner(msgs){
    const banner = document.getElementById('chatMyAnswerBanner');
    if(!banner) return;
    if(!Student.id){ banner.style.display = 'none'; banner.innerHTML = ''; return; }

    const myAnswered = msgs.filter(m => m.isQuestion && m.answered && m.studentId === Student.id && !m.hidden);
    if(!myAnswered.length){
      banner.style.display = 'none';
      banner.innerHTML = '';
      return;
    }

    const last = myAnswered[myAnswered.length - 1]; /* الأحدث، لأن msgs مرتّبة تصاعديًا */
    let dismissedId = null;
    try{ dismissedId = localStorage.getItem('chatDismissedAnswerId'); }catch(e){ /* تجاهل */ }
    if(dismissedId === last.id){
      banner.style.display = 'none';
      banner.innerHTML = '';
      return;
    }

    const answerBody = last.answerAudioUrl
      ? `<audio controls src="${escZoomText(last.answerAudioUrl)}"></audio>`
      : `<div class="chat-msg-text">${escZoomText(last.answerText || '')}</div>`;

    banner.innerHTML = `
      <div class="chat-my-answer-head">
        <span>🎓 جواب الأستاذ على سؤالك</span>
        <button type="button" class="chat-my-answer-close" id="chatMyAnswerClose" title="إخفاء">✕</button>
      </div>
      <div class="chat-my-answer-question">❓ ${escZoomText(last.text || '')}</div>
      ${answerBody}
    `;
    banner.style.display = 'block';

    const closeBtn = document.getElementById('chatMyAnswerClose');
    if(closeBtn){
      closeBtn.addEventListener('click', ()=>{
        try{ localStorage.setItem('chatDismissedAnswerId', last.id); }catch(e){ /* تجاهل */ }
        banner.style.display = 'none';
        banner.innerHTML = '';
      });
    }
  },

  async send(rawText){
    const text = (rawText || '').trim();
    if(!text) return;
    if(!Student.id || !Student.fullName || Student.status !== 'approved'){
      alert('يرجى تسجيل الدخول أولًا للمشاركة في الدردشة.');
      return;
    }
    if(!auxFbReady()){
      alert('الدردشة تحتاج اتصالًا بقاعدة البيانات، تعذّر الإرسال حاليًا.');
      return;
    }
    const isQuestion = text.includes(CHAT_TAG);
    if(isQuestion && !Student.canAskQuestion()){
      const days = Student.daysUntilNextQuestion();
      alert(`لكل تلميذ الحق في طرح سؤال واحد فقط للأستاذ كل أسبوع. يمكنك طرح سؤال جديد بعد ${days} ${days===1?'يوم':'أيام'}.`);
      return;
    }
    try{
      await auxDb().collection('chatMessages').add({
        studentId: Student.id,
        studentName: Student.fullName,
        text,
        isQuestion,
        answered: false,
        answerText: null,
        answerAudioUrl: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      if(isQuestion){
        Student.lastQuestionAt = Date.now(); /* تحديث فوري محليًا حتى لا يُرسل سؤالًا آخر فورًا بالخطأ */
        try{
          await db.collection('students').doc(Student.id).update({
            lastQuestionAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }catch(e){ /* لا نمنع إرسال السؤال إن فشل تحديث هذا الحقل فقط */ }
        updateChatQuotaNote();
      }
    }catch(error){
      console.error('فشل إرسال رسالة الدردشة (تحقق من قواعد Firestore لمجموعة chatMessages):', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('chatMessages');
      alert('تعذّر إرسال الرسالة. راجع التنبيه الظاهر أعلى الصفحة.');
    }
  }
};

/* تحديث سطر تذكير حصة الأسئلة الأسبوعية أعلى مربّع الدردشة */
function updateChatQuotaNote(){
  const el = document.getElementById('chatQuotaNote');
  if(!el) return;
  if(Student.canAskQuestion()){
    el.textContent = '✅ يحق لك طرح سؤال واحد للأستاذ هذا الأسبوع.';
  } else {
    const days = Student.daysUntilNextQuestion();
    el.textContent = `⏳ لقد استخدمت سؤالك الأسبوعي — يمكنك طرح سؤال جديد بعد ${days} ${days===1?'يوم':'أيام'}.`;
  }
}

function renderChatScreen(){
  Chat.ensureListening();
  updateChatQuotaNote();
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const askBtn = document.getElementById('chatAskTeacherBtn');
  if(sendBtn && !sendBtn._wired){
    sendBtn._wired = true;
    const doSend = ()=>{
      const val = input.value;
      input.value = '';
      Chat.send(val);
    };
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', e=>{ if(e.key === 'Enter') doSend(); });
  }
  if(askBtn && !askBtn._wired){
    askBtn._wired = true;
    /* زر "❓ سؤال للأستاذ": يضع وسم #الاستاذ أمام التلميذ مباشرة في خانة الكتابة، بدل أن يكتبه يدويًا */
    askBtn.addEventListener('click', ()=>{
      if(!Student.canAskQuestion()){
        const days = Student.daysUntilNextQuestion();
        alert(`لكل تلميذ الحق في طرح سؤال واحد فقط للأستاذ كل أسبوع. يمكنك طرح سؤال جديد بعد ${days} ${days===1?'يوم':'أيام'}.`);
        return;
      }
      if(!input.value.includes(CHAT_TAG)){
        input.value = (CHAT_TAG + ' ' + input.value).trim();
      }
      input.focus();
    });
  }
}

/* =========================================================================================
   لوحة الأستاذ: صندوق أسئلة التلاميذ (المرسَلة بوسم #الاستاذ) — رد كتابي أو تسجيل صوتي
   ========================================================================================= */
const ChatAdmin = {
  _listening: false,
  _recorder: null,
  _recordedChunks: [],
  _recordingFor: null,

  ensureListening(){
    if(this._listening || !auxFbReady()) return;
    this._listening = true;
    auxDb().collection('chatMessages').where('isQuestion','==',true).where('answered','==',false)
      .orderBy('createdAt','asc')
      .onSnapshot(snap=>{
        const list = snap.docs.map(d=>({ id:d.id, ...d.data() })).filter(q=>!q.hidden);
        this.renderInto(list);
      }, err=>{
        console.error('خطأ في تحميل أسئلة التلاميذ (قد تحتاج فهرسًا مركّبًا في Firestore — الرابط لإنشائه يظهر عادة في رسالة الخطأ هذه في وحدة تحكم المتصفح):', err);
        const el = document.getElementById('chatQuestionsBody');
        if(el) el.innerHTML = '<div class="exam-panel">تعذّر تحميل الأسئلة. راجع الطرفية (Console) — قد يلزم إنشاء فهرس Firestore، الرابط يظهر هناك.</div>';
      });
  },

  renderInto(list){
    const el = document.getElementById('chatQuestionsBody');
    const badge = document.getElementById('chatQuestionsBadge');
    if(badge) badge.textContent = list.length;
    if(!el) return; /* القسم مطوي/غير موجود حاليًا في الصفحة — سيُحدَّث تلقائيًا عند فتحه لاحقًا */
    if(!list.length){
      el.innerHTML = '<div class="exam-panel">لا توجد أسئلة بانتظار الرد حاليًا 👍</div>';
      return;
    }
    el.innerHTML = list.map(q=>`
      <div class="chat-q-card" data-qid="${q.id}">
        <div class="chat-msg-name">${escZoomText(q.studentName||'تلميذ')}</div>
        <div class="chat-msg-text">${escZoomText(q.text||'')}</div>
        <textarea placeholder="اكتب جوابك هنا..." data-answer-input="${q.id}"></textarea>
        <div class="chat-q-actions">
          <button type="button" class="al-key" style="width:auto;padding:7px 16px" data-send-text="${q.id}">📝 إرسال جواب مكتوب</button>
          <button type="button" class="al-key" style="width:auto;padding:7px 16px" data-record="${q.id}">🎙️ تسجيل رد صوتي</button>
          <button type="button" class="al-key chat-q-delete" style="width:auto;padding:7px 16px" data-delete-q="${q.id}">🗑️ حذف السؤال</button>
          <span class="chat-pending-note" data-rec-status="${q.id}"></span>
        </div>
      </div>`).join('');
    this.wire(el);
  },

  wire(el){
    el.querySelectorAll('[data-send-text]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const id = btn.getAttribute('data-send-text');
        const ta = el.querySelector(`[data-answer-input="${id}"]`);
        const answerText = (ta.value || '').trim();
        if(!answerText){ alert('يرجى كتابة الجواب أولًا.'); return; }
        btn.disabled = true; btn.textContent = '⏳ جارٍ الإرسال...';
        try{
          await auxDb().collection('chatMessages').doc(id).update({
            answered:true, answerText, answerAudioUrl:null,
            answeredAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }catch(error){
          console.error('فشل إرسال الجواب المكتوب:', error);
          alert('تعذّر إرسال الجواب. تحقق من قواعد Firestore.');
          btn.disabled = false; btn.textContent = '📝 إرسال جواب مكتوب';
        }
      });
    });

    el.querySelectorAll('[data-record]').forEach(btn=>{
      btn.addEventListener('click', ()=> this.toggleRecording(btn, btn.getAttribute('data-record')));
    });

    el.querySelectorAll('[data-delete-q]').forEach(btn=>{
      btn.addEventListener('click', ()=> this.deleteQuestion(btn, btn.getAttribute('data-delete-q')));
    });
  },

  /* إخفاء السؤال نهائيًا من غير أي رد. نستخدم عمدًا update() بدل delete():
     - نفس صلاحية الكتابة (write) المستخدمة أصلًا في إرسال الأجوبة، والتي تعمل بالفعل عندك
       في قواعد Firestore الحالية — بخلاف صلاحية "الحذف" التي قد تكون غير مفعّلة بشكل منفصل
       في قواعد المشروع، وهو ما يسبب رسالة "تعذّر حذف السؤال".
     - نضيف الحقل hidden:true فقط، ثم نستثني (بالتصفية في الكود) أي مستند يحمل hidden:true
       من كل الأماكن التي تُعرض فيها الأسئلة: لوحة الأستاذ، ودردشة التلميذ العامة، وبطاقة
       "آخر جواب" — فلا يظهر للتلميذ أي أثر للسؤال إطلاقًا. */
  async deleteQuestion(btn, qid){
    if(!confirm('هل تريد حذف هذا السؤال نهائيًا دون الرد عليه؟ لن يظهر أي شيء للتلميذ.')) return;
    const card = btn.closest('.chat-q-card');
    btn.disabled = true; btn.textContent = '⏳ جارٍ الحذف...';
    try{
      await auxDb().collection('chatMessages').doc(qid).update({
        hidden: true,
        hiddenAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      if(card) card.remove();
    }catch(error){
      console.error('فشل حذف السؤال:', error);
      alert('تعذّر حذف السؤال. تحقق من قواعد Firestore.');
      btn.disabled = false; btn.textContent = '🗑️ حذف السؤال';
    }
  },

  /* أقصى مدة تسجيل مسموحة (بالمللي ثانية) — لضمان بقاء الملف (بعد تحويله Base64) ضمن حد حجم مستند Firestore (1MB) */
  MAX_RECORDING_MS: 60000,

  async toggleRecording(btn, qid){
    const statusEl = document.querySelector(`[data-rec-status="${qid}"]`);
    /* إن كان تسجيل آخر جاريًا لسؤال مختلف، أوقفه أولًا */
    if(this._recorder && this._recorder.state === 'recording' && this._recordingFor !== qid){
      this._recorder.stop();
    }
    if(this._recorder && this._recorder.state === 'recording' && this._recordingFor === qid){
      clearTimeout(this._recordingTimeout);
      this._recorder.stop();
      btn.classList.remove('recording'); btn.textContent = '🎙️ تسجيل رد صوتي';
      if(statusEl) statusEl.textContent = '⏳ جارٍ الإرسال...';
      return;
    }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      alert('المتصفح لا يدعم تسجيل الصوت هنا.');
      return;
    }
    if(!auxFbReady()){
      alert('التسجيل الصوتي يحتاج اتصالًا بقاعدة البيانات، تعذّر المتابعة.');
      return;
    }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const recorder = new MediaRecorder(stream);
      this._recorder = recorder; this._recordingFor = qid; this._recordedChunks = [];
      recorder.addEventListener('dataavailable', e=>{ if(e.data.size>0) this._recordedChunks.push(e.data); });
      recorder.addEventListener('stop', async ()=>{
        stream.getTracks().forEach(t=>t.stop());
        const blob = new Blob(this._recordedChunks, { type:'audio/webm' });
        /* نحوّل التسجيل مباشرة إلى Base64 (Data URL) ونخزّنه داخل مستند السؤال في Firestore —
           لا حاجة لـ Firebase Storage (الذي يتطلب خطة Blaze مدفوعة) */
        const reader = new FileReader();
        reader.onloadend = async ()=>{
          const dataUrl = reader.result;
          if(dataUrl.length > 900000){
            if(statusEl) statusEl.textContent = '❌ التسجيل طويل جدًا، أعد تسجيله بمدة أقصر';
            alert('التسجيل طويل جدًا لتخزينه. يرجى تسجيل رد أقصر (أقل من دقيقة).');
            this._recorder = null; this._recordingFor = null;
            return;
          }
          try{
            await auxDb().collection('chatMessages').doc(qid).update({
              answered:true, answerAudioUrl:dataUrl, answerText:null,
              answeredAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            if(statusEl) statusEl.textContent = '✅ تم إرسال الرد الصوتي';
          }catch(error){
            console.error('فشل إرسال التسجيل الصوتي (تحقق من قواعد Firestore):', error);
            if(statusEl) statusEl.textContent = '❌ تعذّر إرسال التسجيل';
            alert('تعذّر إرسال التسجيل الصوتي. تحقق من قواعد Firestore.');
          }
          this._recorder = null; this._recordingFor = null;
        };
        reader.readAsDataURL(blob);
      });
      recorder.start();
      btn.classList.add('recording'); btn.textContent = '⏹️ إيقاف التسجيل';
      if(statusEl) statusEl.textContent = '🔴 جارٍ التسجيل... (يتوقف تلقائيًا بعد دقيقة)';
      this._recordingTimeout = setTimeout(()=>{
        if(this._recorder && this._recorder.state === 'recording' && this._recordingFor === qid){
          this._recorder.stop();
          btn.classList.remove('recording'); btn.textContent = '🎙️ تسجيل رد صوتي';
          if(statusEl) statusEl.textContent = '⏳ جارٍ الإرسال...';
        }
      }, this.MAX_RECORDING_MS);
    }catch(error){
      console.error('تعذّر الوصول للميكروفون:', error);
      alert('تعذّر الوصول للميكروفون. تحقق من إذن المتصفح.');
    }
  }
};

async function renderAdminPanel(){
  const wrap = document.getElementById('adminWrap');
  wrap.innerHTML = '<div class="sf-label">جاري التحميل…</div>';
  await Locks.load();
  const pending = await Admin.listPending();
  const { total:totalStudents, online:onlineStudents } = await Admin.studentsCounts();

  let pendingBody;
  if(!pending.length){
    pendingBody = `<div class="exam-panel">لا توجد طلبات تسجيل قيد الانتظار حاليًا.</div>`;
  } else {
    pendingBody = pending.map(p=>`
      <div class="stat-card" style="text-align:center">
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:10px">
          ${AA_ICONS.singleStudent}
          <div class="sc-title">${p.fullName}</div>
        </div>
        ${p.receiptImage
          ? `<img src="${p.receiptImage}" alt="وصل الدفع" style="max-width:100%;max-height:260px;border-radius:12px;border:1.4px solid var(--gold-3);margin-bottom:10px">`
          : `<div class="exam-panel" style="margin-bottom:10px">⚠️ لا توجد صورة وصل مرفَقة</div>`}
        <div style="display:flex;gap:10px;justify-content:center">
          <button class="al-key" style="width:auto;padding:8px 20px" data-approve="${p.id}">✅ قبول</button>
          <button class="al-key" style="width:auto;padding:8px 20px" data-reject="${p.id}">❌ رفض</button>
        </div>
      </div>`).join('');
  }

  const approvedBody = `
    <div class="stat-card" style="text-align:center;margin-bottom:10px">
      🟢 <b>متصل الآن: ${onlineStudents}</b> / ${totalStudents}
      <div class="sf-label" style="margin-top:4px">يُحتسب كل من فتح المنصة خلال آخر 6 دقائق</div>
    </div>
    <button class="al-key" id="toggleApprovedBtn" style="width:100%">👥 عدد التلاميذ المقبولين: ${totalStudents} — اضغط لعرض الأسماء والمستوى</button>
    <div id="approvedListContainer" style="display:none;margin-top:12px"></div>`;

  let lessonsBody = `<div class="lesson-list">`;
  window.LESSONS.forEach(l=>{
    const pendingLesson = l.locked === 'pending';
    const open = !pendingLesson && !Locks.isLessonLocked(l.id);
    lessonsBody += `<div class="lesson-row ${pendingLesson?'placeholder':''}">
      <div class="lr-num"><span class="lr-num-text">${String(l.order).padStart(2,'0')}</span></div>
      <div class="lr-text"><div class="lr-title">${l.title}</div></div>
      ${pendingLesson
        ? `<div class="lr-status">⏳ بلا محتوى بعد</div>`
        : `<button class="al-key" style="width:auto;padding:6px 14px" data-toggle-lesson="${l.id}">${open?'🔓 مفتوح — اضغط للإغلاق':'🔒 مغلق — اضغط للفتح'}</button>`}
    </div>`;
  });
  lessonsBody += `</div>`;

  let trimestersBody = `<div class="lesson-list">`;
  [{k:'t1',l:'الفصل الأول'},{k:'t2',l:'الفصل الثاني'},{k:'t3',l:'الفصل الثالث'}].forEach(t=>{
    const open = Locks.isTrimesterOpen(t.k);
    trimestersBody += `<div class="lesson-row"><div class="lr-text"><div class="lr-title">${t.l}</div></div>
      <button class="al-key" style="width:auto;padding:6px 14px" data-toggle-trimester="${t.k}">${open?'🔓 مفتوح — اضغط للإغلاق':'🔒 مغلق — اضغط للفتح'}</button></div>`;
  });
  trimestersBody += `</div>
    <div class="note" style="margin-top:12px">
      <b>📢 إشعار فرض/اختبار جديد</b><br>
      عند فتح فصل مغلق حديثًا يُرسَل إشعار تلقائيًا لكل التلاميذ. أما إن كان الفصل مفتوحًا أصلًا
      ورفعتَ فرضًا أو اختبارًا جديدًا داخل مجلده على GitHub، استخدم الزر أدناه لإعلام التلاميذ به فورًا
      دون الحاجة لإغلاق الفصل وإعادة فتحه.
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input type="text" id="newExamNotifyName" placeholder="مثال: فرض المحروسة الأول — الفصل الثاني"
               style="flex:1;min-width:160px;padding:8px 10px;border-radius:10px;border:1.3px solid var(--gold-3);font-family:inherit">
        <button type="button" class="al-key" style="width:auto;padding:8px 16px" id="sendExamNotifyBtn">📢 إرسال إشعار</button>
      </div>
    </div>`;

  let situationsBody = `<div class="lesson-list">`;
  (window.SITU_PRACTICE || []).forEach(seg=>{
    const open = !Locks.isSituationLocked(seg.key);
    situationsBody += `<div class="lesson-row">
      <div class="lr-num"><span class="lr-num-text">${String(seg.num).padStart(2,'0')}</span></div>
      <div class="lr-text"><div class="lr-title">${seg.icon} ${seg.title}</div></div>
      <button class="al-key" style="width:auto;padding:6px 14px" data-toggle-situation="${seg.key}">${open?'🔓 مفتوح — اضغط للإغلاق':'🔒 مغلق — اضغط للفتح'}</button>
    </div>`;
  });
  situationsBody += `</div>`;

  const irabOpen = Locks.isIrabOpen();
  const irabBody = `<div class="lesson-list">
    <div class="lesson-row"><div class="lr-text"><div class="lr-title">✍️ إعراب الجمل (101 جملة وجملة)</div></div>
      <button class="al-key" style="width:auto;padding:6px 14px" id="toggleIrabBtn">${irabOpen?'🔓 مفتوح — اضغط للإغلاق':'🔒 مغلق — اضغط للفتح'}</button></div>
  </div>`;

  const statsBody = `<div id="adminStatsMount"></div>`;
  const aiTeacherBody = `
    <div class="note" style="margin-bottom:12px">🧠 وحدة منفصلة تتيح إنشاء اختبار (نص/جدول/رسوم)، طباعته، ورفع تلميذ صورة إجابته لتصحّح تلقائيًا بالذكاء الاصطناعي مع علامة وتقرير فوري.
      <br><b>عند أول استخدام</b> ستطلب منك لوحة الأستاذ(ة) هناك رمزًا سريًا خاصًا بها (منفصل عن رمز هذه اللوحة)، ثم رابط خادم التصحيح (Worker) — راجع ملف <b>worker.js</b> وREADME المرفقين لنشره خلال دقائق.</div>
    <a class="al-key" style="display:inline-block;width:auto;padding:9px 22px;text-decoration:none" href="smart-teacher.html">🧠 فتح لوحة المعلّم الذكي</a>
    <div class="note" style="margin-top:12px">💡 بعد نشر اختبار هناك، انسخ رابطه وأرسله لكل التلاميذ عبر قسم "👥 التلاميذ المقبولون" أدناه أو أي وسيلة تواصل معتادة.</div>`;

  const dailyExercisesBody = `
    <div class="note" style="margin-bottom:12px">📆 وحدة مستقلة خاصة بالتمارين اليومية فقط — ارفع ملف التمرين (PDF) مع ملف الحل النموذجي، وستظهر هنا حصريًا التمارين اليومية (لا تختلط بلائحة الفروض والاختبارات).
      <br>التلميذ(ة) يطبع التمرين أو يحلّه كتابةً مباشرة، ويُصحَّح فوريًا بالذكاء الاصطناعي.</div>
    <a class="al-key" style="display:inline-block;width:auto;padding:9px 22px;text-decoration:none" href="smart-teacher.html?cat=daily">📆 فتح لوحة التمارين اليومية</a>
    <div class="note" style="margin-top:12px">💡 نتائج التمارين اليومية تُحسب تلقائيًا ضمن ترتيب الفروض والاختبارات العام — بلا أي إعداد إضافي.</div>`;

  /* زر بارز لإدارة روابط تسجيلات حصص الزوم للأفواج الأربعة — يفتح نافذة منبثقة مستقلة */
  const zoomManageCard = `
    <div class="home-card-wide zoom-manage-card" id="zoomManageBtn" style="margin-bottom:16px;cursor:pointer">
      <div class="hc-icon-wrap" style="background:linear-gradient(150deg,#FBEDC3,#E7C878)">
        <svg class="hc-svg-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <rect x="8" y="22" width="32" height="24" rx="4" fill="url(#hcInk)" stroke="#16241C" stroke-width="1"/>
          <path d="M40 28 L55 21 L55 47 L40 40 Z" fill="url(#hcGoldDark)" stroke="#5C3D0F" stroke-width="1" stroke-linejoin="round"/>
          <circle cx="19" cy="34" r="9" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1.2"/>
          <circle cx="19" cy="34" r="3.4" fill="#3E2A18"/>
          <circle cx="10.5" cy="18" r="5.5" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
          <circle cx="24" cy="16" r="4.5" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
          <path d="M8 22 L40 22 L40 26 L8 26 Z" fill="#fff" opacity="0.22"/>
        </svg>
      </div>
      <div>
        <div class="hc-title">إدارة حصص الزوم</div>
        <div class="hc-sub">أضف/حدّث روابط تسجيلات كل درس للأفواج الأربعة — تظهر فورًا للتلاميذ</div>
      </div>
    </div>`;

  /* زر بارز لإدارة روابط الفروض والاختبارات — موحّدة لكل الأفواج، بنفس أسلوب رفع روابط الزوم */
  const examLinksManageCard = `
    <div class="home-card-wide zoom-manage-card" id="examLinksManageBtn" style="margin-bottom:16px;cursor:pointer">
      <div class="hc-icon-wrap" style="background:linear-gradient(150deg,#F0E6D6,#D8AE52)">
        <svg class="hc-svg-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <rect x="13" y="9" width="30" height="40" rx="3" fill="url(#hcCream)" stroke="#D8AE52" stroke-width="1"/>
          <rect x="23" y="5" width="10" height="8" rx="2" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
          <path d="M18 21 L38 21 M18 27 L38 27 M18 33 L31 33" stroke="#8A6A2A" stroke-width="1.4" opacity="0.6"/>
          <path d="M19 47 C29 40 39 32 49 20 L54 25 C44 37 34 45 24 52 Z" fill="url(#hcWood)" stroke="#241708" stroke-width="1"/>
          <path d="M49 20 L54 25 L57 22 C58.5 20.5 58.5 18.5 57 17 C55.5 15.5 53.5 15.5 52 17 Z" fill="url(#hcGoldMetal)" stroke="#7A5216" stroke-width="1"/>
          <path d="M19 47 L24 52 L21 56 C20 57 18 56.6 18 55 Z" fill="#1D1408"/>
        </svg>
      </div>
      <div>
        <div class="hc-title">إدارة روابط الفروض والاختبارات</div>
        <div class="hc-sub">أضف/حدّث روابط الفصول الثلاثة — رابط واحد موحّد لكل التلاميذ</div>
      </div>
    </div>`;

  /* زر لفتح محادثة بوت تيليجرام مباشرة — هناك تصل حلول التمارين التي يرسلها التلاميذ */
  const solutionsCard = `
    <div class="home-card-wide zoom-manage-card" id="solutionsBotBtn" style="margin-bottom:16px;cursor:pointer">
      <div class="hc-icon-wrap" style="background:linear-gradient(150deg,#D9EAD9,#8FC98F)">
        <svg class="hc-svg-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 20 L32 20 L36 24 L56 24 L56 46 L8 46 Z" fill="url(#hcInk)" stroke="#16241C" stroke-width="1"/>
          <path d="M10 24 L54 24 L54 44 L10 44 Z" fill="url(#hcCream)" stroke="#D8AE52" stroke-width="1"/>
          <path d="M10 24 L32 39 L54 24" fill="none" stroke="#8A6A2A" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="46" cy="38" r="9.5" fill="url(#hcSageGem)" stroke="#2E4A34" stroke-width="1"/>
          <path d="M41.5 38 L44.7 41.2 L51 34" fill="none" stroke="#F4FBF6" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div>
        <div class="hc-title">حلول التلاميذ للواجب المنزلي المقدم في حصة الزوم</div>
        <div class="hc-sub">إحصائيات من أرسل حلاً لكل درس/فوج، وزر لفتح ملفات الحلول على تيليجرام</div>
      </div>
    </div>`;

  /* زر لفتح محادثة بوت تيليجرام مباشرة — هناك تصل حلول الفروض والاختبارات التي يرسلها التلاميذ */
  const examSolutionsCard = `
    <div class="home-card-wide zoom-manage-card" id="examSolutionsBotBtn" style="margin-bottom:16px;cursor:pointer">
      <div class="hc-icon-wrap" style="background:linear-gradient(150deg,#F0E6D6,#D8AE52)">
        <svg class="hc-svg-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 20 L32 20 L36 24 L56 24 L56 46 L8 46 Z" fill="url(#hcInk)" stroke="#16241C" stroke-width="1"/>
          <path d="M10 24 L54 24 L54 44 L10 44 Z" fill="url(#hcCream)" stroke="#D8AE52" stroke-width="1"/>
          <path d="M10 24 L32 39 L54 24" fill="none" stroke="#8A6A2A" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="46" cy="38" r="9.5" fill="url(#hcGoldMedallion)" stroke="#7A5216" stroke-width="1"/>
          <path d="M41.5 38 L44.7 41.2 L51 34" fill="none" stroke="#4A3200" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div>
        <div class="hc-title">حلول التلاميذ للفروض والاختبارات</div>
        <div class="hc-sub">إحصائيات من أرسل حلاً لكل فصل، وزر لفتح ملفات الحلول على تيليجرام</div>
      </div>
    </div>`;

  wrap.innerHTML =
    adminAccordionHTML('chatQuestions', `${AA_ICONS.chat} أسئلة التلاميذ (الدردشة) <span class="aa-badge" id="chatQuestionsBadge">0</span>`, `<div id="chatQuestionsBody"><div class="exam-panel">جارٍ التحميل…</div></div>`) +
    adminAccordionHTML('pending', `${AA_ICONS.pending} طلبات الانتظار <span class="aa-badge">${pending.length}</span>`, pendingBody) +
    adminAccordionHTML('approved', `${AA_ICONS.approved} التلاميذ المقبولون <span class="aa-badge">${totalStudents}</span>`, approvedBody) +
    `<button class="al-key" id="forceRefreshLbBtn" style="width:100%;margin:6px 0 14px;">🔄 تحديث الترتيب الآن (بدل انتظار ساعة)</button>` +
    zoomManageCard +
    examLinksManageCard +
    solutionsCard +
    examSolutionsCard +
    adminAccordionHTML('lessons', `${AA_ICONS.lessons} فتح/إغلاق الدروس`, lessonsBody) +
    adminAccordionHTML('trimesters', `${AA_ICONS.exams} فتح/إغلاق الفروض والاختبارات`, trimestersBody) +
    adminAccordionHTML('situations', `${AA_ICONS.situations} فتح/إغلاق وضعيات الاستئناس (المقاطع)`, situationsBody) +
    adminAccordionHTML('irab', `${AA_ICONS.irab} فتح/إغلاق إعراب الجمل`, irabBody) +
    adminAccordionHTML('aiTeacher', `${AA_ICONS.aiTeacher} المعلّم الذكي — اختبارات وتصحيح آلي`, aiTeacherBody) +
    adminAccordionHTML('dailyExercises', `${AA_ICONS.dailyExercises} تمارين يومية`, dailyExercisesBody) +
    adminAccordionHTML('stats', `${AA_ICONS.stats} إحصائيات كل درس`, statsBody);

  wireAdminAccordions(wrap);
  const forceRefreshBtn = document.getElementById('forceRefreshLbBtn');
  if(forceRefreshBtn) forceRefreshBtn.onclick = async ()=>{
    forceRefreshBtn.disabled = true;
    forceRefreshBtn.textContent = 'جارٍ إعادة الحساب...';
    try{
      await Leaderboard.refreshIfStale(true);
      alert('تم تحديث الترتيب بنجاح ✅');
    }catch(e){
      alert('تعذّر تحديث الترتيب، حاول مرة أخرى.');
    }
    forceRefreshBtn.disabled = false;
    forceRefreshBtn.textContent = '🔄 تحديث الترتيب الآن (بدل انتظار ساعة)';
  };
  ChatAdmin.ensureListening();

  document.getElementById('zoomManageBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    openZoomManagerModal();
  });

  document.getElementById('examLinksManageBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    openExamLinksManagerModal();
  });

  document.getElementById('solutionsBotBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    openSolutionsModal();
  });

  document.getElementById('examSolutionsBotBtn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    openExamSolutionsModal();
  });

  const toggleBtn = document.getElementById('toggleApprovedBtn');
  const listContainer = document.getElementById('approvedListContainer');
  let approvedLoaded = false;
  toggleBtn.addEventListener('click', async ()=>{
    const showing = listContainer.style.display !== 'none';
    if(showing){ listContainer.style.display = 'none'; return; }
    listContainer.style.display = 'block';
    if(approvedLoaded) return;
    approvedLoaded = true;
    listContainer.innerHTML = `
      <input type="text" id="studentSearchInput" placeholder="🔎 ابحث عن تلميذ بالاسم..." style="width:100%;padding:10px 14px;border-radius:11px;border:1.4px solid #A97F2A;font-family:'Cairo';font-size:13px;margin-bottom:12px;background:#FFFDF7;color:#22352B">
      <div class="lesson-list" id="approvedListRows"></div>`;
    const rowsWrap = document.getElementById('approvedListRows');
    const students = await Admin.listApprovedFull();
    if(!students.length){ rowsWrap.innerHTML = `<div class="exam-panel">لا يوجد بعد أي تلميذ مقبول.</div>`; return; }
    rowsWrap.innerHTML = students.map((s,i)=>`
      <div class="lesson-row" data-student-name="${s.fullName}">
        ${AA_ICONS.singleStudent}
        <div class="lr-text"><div class="lr-title">${s.fullName}</div></div>
        <div class="lr-status" id="perf-${s.id}" style="font-size:11px;font-weight:800;color:#5B6E62">…</div>
      </div>`).join('');
    document.getElementById('studentSearchInput').addEventListener('input', (e)=>{
      const q = normalizeAr(e.target.value);
      rowsWrap.querySelectorAll('[data-student-name]').forEach(row=>{
        const name = normalizeAr(row.getAttribute('data-student-name'));
        row.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
      });
    });
    /* حساب مستوى كل تلميذ من الحقول الجاهزة أصلًا ضمن بيانات القائمة (بلا أي قراءة إضافية) */
    students.forEach((s)=>{
      const count = (typeof s.completedExercisesCount === 'number') ? s.completedExercisesCount : 0;
      const avg = (count > 0 && typeof s.totalScoreSum === 'number') ? Math.round(s.totalScoreSum / count) : null;
      const el = document.getElementById('perf-'+s.id);
      if(el) el.textContent = (avg === null) ? 'لم يشارك بعد' : ('مستواه: ' + avg + '%');
    });
  });

  document.getElementById('adminLogoutBtn').addEventListener('click', ()=>{
    if(!confirm('هل تريد تسجيل الخروج من لوحة التحكم؟')) return;
    if(window.SoundFX) SoundFX.logout();
    Admin.authed = false;
    Admin.stopListenPending();
    Screens.show('home');
  });

  wrap.querySelectorAll('[data-approve]').forEach(b=> b.addEventListener('click', async ()=>{ await Admin.approve(b.getAttribute('data-approve')); renderAdminPanel(); }));
  wrap.querySelectorAll('[data-reject]').forEach(b=> b.addEventListener('click', async ()=>{ await Admin.reject(b.getAttribute('data-reject')); renderAdminPanel(); }));
  wrap.querySelectorAll('[data-toggle-lesson]').forEach(b=> b.addEventListener('click', async ()=>{
    const id = b.getAttribute('data-toggle-lesson');
    const open = !Locks.isLessonLocked(id);
    
    /* الحصول على عنوان الدرس */
    const lesson = window.LESSONS.find(l => l.id === id);
    const lessonTitle = lesson ? lesson.title : 'درس جديد';
    
    /* فتح أو إغلاق الدرس مع الإشعار */
    if(!open && typeof LocksEnhanced !== 'undefined' && LocksEnhanced.setLessonWithNotification){
      await LocksEnhanced.setLessonWithNotification(id, true, lessonTitle);
    } else {
      try{
        await Locks.setLesson(id, !open);
      }catch(error){
        console.error('فشل إغلاق الدرس (تحقق من قواعد Firestore لمجموعة state):', error);
        if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
        alert('تعذّر حفظ حالة الدرس في قاعدة البيانات. راجع التنبيه الظاهر أعلى الصفحة.');
      }
    }
    
    renderAdminPanel();
  }));
  wrap.querySelectorAll('[data-toggle-trimester]').forEach(b=> b.addEventListener('click', async ()=>{
    const k = b.getAttribute('data-toggle-trimester');
    const open = Locks.isTrimesterOpen(k);
    const labels = {t1:'الفصل الأول', t2:'الفصل الثاني', t3:'الفصل الثالث'};
    const label = labels[k] || 'فروض واختبارات';

    /* فتح الفصل مع إرسال إشعار فوري للتلاميذ بوجود فروض/اختبارات جديدة متاحة */
    if(!open && typeof LocksEnhanced !== 'undefined' && LocksEnhanced.setTrimesterWithNotification){
      await LocksEnhanced.setTrimesterWithNotification(k, true, label);
    } else {
      try{
        await Locks.setTrimester(k, !open);
      }catch(error){
        console.error('فشل تحديث حالة الفصل (تحقق من قواعد Firestore لمجموعة state):', error);
        if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
        alert('تعذّر حفظ حالة الفصل في قاعدة البيانات. راجع التنبيه الظاهر أعلى الصفحة.');
      }
    }
    renderAdminPanel();
  }));
  const sendExamNotifyBtn = document.getElementById('sendExamNotifyBtn');
  if(sendExamNotifyBtn){
    sendExamNotifyBtn.addEventListener('click', async ()=>{
      const input = document.getElementById('newExamNotifyName');
      const name = (input.value || '').trim();
      if(!name){ alert('يرجى كتابة اسم الفرض أو الاختبار أولًا.'); return; }
      sendExamNotifyBtn.disabled = true;
      sendExamNotifyBtn.textContent = '⏳ جارٍ الإرسال...';
      const sent = typeof NotificationsSystem !== 'undefined'
        ? await NotificationsSystem.addNewContentAlert('exam', name, 'متاح الآن للتلاميذ')
        : false;
      sendExamNotifyBtn.disabled = false;
      sendExamNotifyBtn.textContent = '📢 إرسال إشعار';
      if(sent){ input.value = ''; alert('تم إرسال الإشعار بنجاح لجميع التلاميذ.'); }
      else { alert('تعذّر إرسال الإشعار. تحقق من اتصال Firebase وقواعد Firestore.'); }
    });
  }
  document.getElementById('toggleIrabBtn').addEventListener('click', async ()=>{
    const open = Locks.isIrabOpen();
    try{
      await Locks.setIrabOpen(!open);
    }catch(error){
      console.error('فشل تحديث حالة قفل إعراب الجمل (تحقق من قواعد Firestore لمجموعة state):', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
      alert('تعذّر حفظ حالة إعراب الجمل في قاعدة البيانات. راجع التنبيه الظاهر أعلى الصفحة.');
    }
    updateIrabHomeCardLock();
    renderAdminPanel();
  });
  wrap.querySelectorAll('[data-toggle-situation]').forEach(b=> b.addEventListener('click', async ()=>{
    const k = b.getAttribute('data-toggle-situation');
    const open = !Locks.isSituationLocked(k);
    try{
      await Locks.setSituation(k, !open);
    }catch(error){
      console.error('فشل تحديث حالة قفل المقطع (تحقق من قواعد Firestore لمجموعة state):', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
      alert('تعذّر حفظ حالة المقطع في قاعدة البيانات. راجع التنبيه الظاهر أعلى الصفحة.');
    }
    renderAdminPanel();
  }));

  const statsMount = document.getElementById('adminStatsMount');
  for(const l of window.LESSONS){
    if(l.locked==='pending') continue;
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.dataset.lessonId = l.id;
    card.innerHTML = `
      <div class="sc-head" style="cursor:pointer;" data-stats-toggle>
        <div class="sc-num">${String(l.order).padStart(2,'0')}</div>
        <div class="sc-title">${l.title}</div>
      </div>
      <div class="stat-card-body" style="display:none;">
        <div class="sf-label" style="padding:10px 0;">اضغط لعرض إحصائيات هذا الدرس…</div>
      </div>`;
    statsMount.appendChild(card);
  }
  /* الإحصائيات لا تُحسب إلا عند فتح الدرس فعليًا (وليس لكل الدروس دفعة واحدة عند كل فتح للوحة) —
     كل درس يُحمَّل مرة واحدة فقط لكل جلسة (يُخزَّن الناتج مؤقتًا في dataset.loaded) ثم يُطوى/يُفتح
     محليًا بلا أي قراءة إضافية من Firestore. */
  statsMount.querySelectorAll('[data-stats-toggle]').forEach(head=>{
    head.addEventListener('click', async ()=>{
      const card = head.closest('.stat-card');
      const body = card.querySelector('.stat-card-body');
      const isOpen = body.style.display !== 'none';
      if(isOpen){ body.style.display = 'none'; return; }
      body.style.display = '';
      if(card.dataset.loaded === '1') return; // مُحمَّل مسبقًا هذه الجلسة، لا داعي لإعادة القراءة
      const lessonId = card.dataset.lessonId;
      body.innerHTML = '<div class="sf-label" style="padding:10px 0;">جاري التحميل…</div>';
      try{
        const st = await Admin.lessonStats(lessonId, totalStudents);
        const pctParticipation = totalStudents ? Math.round((st.participants/totalStudents)*100) : 0;
        body.innerHTML = `
          <div class="stat-row">
            <div class="stat-box"><div class="sb-value">${st.participants}</div><div class="sb-label">مشارك من ${st.total}</div></div>
            <div class="stat-box"><div class="sb-value">${pctParticipation}%</div><div class="sb-label">نسبة المشاركة</div></div>
            <div class="stat-box"><div class="sb-value">${st.avg}%</div><div class="sb-label">متوسط التقدّم</div></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${st.avg}%"></div></div>`;
        card.dataset.loaded = '1';
      }catch(e){
        body.innerHTML = '<div class="sf-label" style="padding:10px 0;">تعذّر تحميل إحصائيات هذا الدرس.</div>';
      }
    });
  });
}

/* =========================================================================================
   نافذة "إدارة حصص الزوم" — منبثقة مستقلة من لوحة تحكم الأستاذ
   خطوتان داخل نفس النافذة: 1) قائمة كل الدروس  2) نموذج حقول الأفواج للدرس المختار
   كل درس جديد يُضاف مستقبلاً إلى LESSONS يظهر هنا تلقائيًا دون أي تعديل على هذا الكود.
   ========================================================================================= */
const ZOOM_GROUPS = [
  { key:'g1', label:'فوج الإثنين' },
  { key:'g2', label:'فوج التلاثاء' },
  { key:'g3', label:'فوج الأربعاء' },
  { key:'g4', label:'فوج الخميس' },
  { key:'g5', label:'فوج المخزن' }
];

/* وثيقتا "ملخّص الدرس" و"تمارينه" — رابط مستقل لكل فوج (كل فوج له وثائقه ورابط فيديو خاص به) */
const ZOOM_DOCS = [
  { key:'summary',   label:'📄 رابط ملخّص الدرس', icon:'📄', btnLabel:'تحميل ملخّص الدرس' },
  { key:'exercises', label:'📝 رابط الواجب المنزلي', icon:'📝', btnLabel:'تحميل واجب منزلي' }
];

/* تفادي حقن HTML عند عرض روابط/عناوين داخل سمات value="" أو نص عادي */
function escZoomText(s){
  return String(s==null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function openZoomManagerModal(){
  if(!fbReady){
    alert('Firebase غير مفعّل. لا يمكن حفظ روابط حصص الزوم بدونه.');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'zoom-modal-overlay';
  overlay.innerHTML = `
    <div class="zoom-modal-popup">
      <div class="zoom-modal-header">
        <div class="zoom-modal-title">🎥 إدارة حصص الزوم</div>
        <div class="zoom-modal-subtitle" id="zoomModalSubtitle">اختر درسًا لإضافة أو تعديل روابط تسجيلاته</div>
        <button type="button" class="zoom-modal-close" id="zoomModalCloseBtn">✕</button>
      </div>
      <div class="zoom-modal-body" id="zoomModalBody"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.remove(); });
  overlay.querySelector('#zoomModalCloseBtn').addEventListener('click', ()=> overlay.remove());

  renderZoomManagerList(overlay);
}

async function renderZoomManagerList(overlay){
  const body = overlay.querySelector('#zoomModalBody');
  overlay.querySelector('#zoomModalSubtitle').textContent = 'اختر درسًا لإضافة أو تعديل روابط تسجيلاته';
  body.innerHTML = '<div class="sf-label">جاري التحميل…</div>';

  await ZoomLinks.load();

  const rows = window.LESSONS.map(l=>{
    const has = ZoomLinks.hasAnyLink(l.id);
    return `<div class="lesson-row zoom-lesson-row" data-zoom-lesson="${l.id}">
      <div class="lr-num"><span class="lr-num-text">${String(l.order).padStart(2,'0')}</span></div>
      <div class="lr-text"><div class="lr-title">${escZoomText(l.title)}</div></div>
      <div class="lr-status" title="${has?'توجد روابط محفوظة':'لا توجد روابط بعد'}">${has?'🎬':'➕'}</div>
    </div>`;
  }).join('');

  body.innerHTML = `<div class="lesson-list">${rows}</div>`;

  body.querySelectorAll('[data-zoom-lesson]').forEach(row=>{
    row.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const lesson = window.LESSONS.find(l=>l.id === row.getAttribute('data-zoom-lesson'));
      if(lesson) renderZoomManagerForm(overlay, lesson);
    });
  });
}

/* الحقول الثلاثة القابلة للتكرار داخل كل فوج — فيديو الحصة، ملخّص الدرس، تمارينه.
   كل حقل الآن قد يحمل أكثر من رابط واحد (مثلاً أكثر من حصة، أو ملخّص على أكثر من جزء) */
const ZOOM_FORM_FIELDS = [
  { key:'video',     label:'🎥 روابط تسجيل الحصة (فيديو)', addLabel:'+ إضافة رابط فيديو آخر' },
  { key:'summary',   label:'📄 روابط ملخّص الدرس',          addLabel:'+ إضافة رابط ملخّص آخر' },
  { key:'exercises', label:'📝 روابط الواجب المنزلي',          addLabel:'+ إضافة رابط واجب آخر' }
];

/* يضيف صفًّا جديدًا (حقل إدخال + زر حذف) داخل حاوية روابط حقل معيّن */
function addZoomLinkRow(container, value){
  const row = document.createElement('div');
  row.className = 'zoom-link-row';
  row.innerHTML = `
    <input type="text" class="zoom-form-input" placeholder="https://…" value="${escZoomText(value||'')}">
    <button type="button" class="zoom-link-remove-btn" title="حذف هذا الرابط">✕</button>`;
  row.querySelector('.zoom-link-remove-btn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    row.remove();
  });
  container.appendChild(row);
}

function renderZoomManagerForm(overlay, lesson){
  const body = overlay.querySelector('#zoomModalBody');
  overlay.querySelector('#zoomModalSubtitle').textContent = lesson.title;
  const links = ZoomLinks.getLinks(lesson.id);

  /* لكل فوج قسم مستقل بثلاثة حقول قابلة للتكرار: فيديو الحصة + ملخّص الدرس + تمارينه — لأن
     كل فوج قد يملك توقيتًا ووثائق مختلفة تمامًا عن الأفواج الأخرى، وقد يحتاج أكثر من رابط
     واحد لكل نوع (أكثر من حصة، ملخّص على أجزاء…) */
  const groupsHtml = ZOOM_GROUPS.map(g=>{
    const fieldsHtml = ZOOM_FORM_FIELDS.map(f=> `
      <div class="zoom-form-group">
        <label class="zoom-form-label">${f.label}</label>
        <div class="zoom-link-rows" id="zoomRows-${g.key}-${f.key}"></div>
        <button type="button" class="zoom-add-link-btn" data-zoom-add="${g.key}-${f.key}">${f.addLabel}</button>
      </div>`).join('');
    return `<div class="zoom-form-divider"><span>${g.label}</span></div>${fieldsHtml}`;
  }).join('');

  body.innerHTML = `
    <button type="button" class="zoom-back-btn" id="zoomFormBackBtn">→ رجوع لقائمة الدروس</button>
    <div class="zoom-form-note">لكل فوج 3 حقول: تسجيل الحصة، ملخّص الدرس، والواجب المنزلي — ويمكنك إضافة أكثر من رابط لكل حقل بالضغط على «+ إضافة رابط آخر». اترك الحقل فارغًا إن لم يتوفّر بعد، ثم اضغط «حفظ الروابط» في الأسفل.
      <br>✅ روابط يوتيوب/فيميو/Google Drive الخاصة بالفيديو تُشغَّل مباشرة داخل الصفحة.
      <br>📨 روابط تيليجرام (مثل <bdi style="direction:ltr;display:inline-block">t.me/c/…</bdi>) — سواء للفيديو أو للوثائق — تظهر للتلميذ كزر "فتح على تيليجرام"، لأن تيليجرام لا يسمح بالتضمين المباشر، ويشترط أن يكون التلميذ عضوًا مقبولًا في قناة/مجموعة فوجه.</div>
    ${groupsHtml}
    <button type="button" class="zoom-save-btn" id="zoomSaveBtn">💾 حفظ الروابط</button>
    <div class="zoom-save-feedback" id="zoomSaveFeedback"></div>`;

  /* تعبئة كل حاوية بصفوفها الحالية (رابط واحد فارغ افتراضيًا إن لم يكن هناك أي رابط محفوظ بعد،
     حتى يبقى هناك دومًا حقل واحد جاهز للكتابة، تمامًا كما كانت الواجهة سابقًا) */
  ZOOM_GROUPS.forEach(g=>{
    ZOOM_FORM_FIELDS.forEach(f=>{
      const container = body.querySelector(`#zoomRows-${g.key}-${f.key}`);
      const vals = links[g.key][f.key];
      if(vals.length){
        vals.forEach(v=> addZoomLinkRow(container, v));
      } else {
        addZoomLinkRow(container, '');
      }
    });
  });

  body.querySelectorAll('[data-zoom-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const containerId = 'zoomRows-' + btn.getAttribute('data-zoom-add');
      addZoomLinkRow(body.querySelector('#'+containerId), '');
    });
  });

  body.querySelector('#zoomFormBackBtn').addEventListener('click', ()=> renderZoomManagerList(overlay));

  body.querySelector('#zoomSaveBtn').addEventListener('click', async ()=>{
    const saveBtn = body.querySelector('#zoomSaveBtn');
    const feedback = body.querySelector('#zoomSaveFeedback');
    const newGroups = {};
    ZOOM_GROUPS.forEach(g=>{
      newGroups[g.key] = {};
      ZOOM_FORM_FIELDS.forEach(f=>{
        const container = body.querySelector(`#zoomRows-${g.key}-${f.key}`);
        const inputs = Array.from(container.querySelectorAll('.zoom-form-input'));
        newGroups[g.key][f.key] = inputs.map(inp=> inp.value.trim()).filter(Boolean);
      });
    });

    saveBtn.disabled = true; saveBtn.textContent = '⏳ جاري الحفظ…';
    try{
      const res = await ZoomLinks.setLinks(lesson.id, newGroups);
      if(res && res.ok){
        if(window.SoundFX) SoundFX.correct();
        feedback.textContent = '✅ تم حفظ الروابط بنجاح — أصبحت متاحة فورًا للتلاميذ.';
        feedback.style.color = 'var(--sage-deep,#3F6350)';
      } else {
        throw new Error(res && res.reason || 'unknown');
      }
    }catch(error){
      console.error('فشل حفظ روابط حصص الزوم (تحقق من قواعد Firestore لمجموعة state):', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('zoomLinks');
      feedback.textContent = '⚠️ تعذّر حفظ الروابط. راجع التنبيه الظاهر أعلى الصفحة.';
      feedback.style.color = '#b5432a';
    }
    saveBtn.disabled = false; saveBtn.textContent = '💾 حفظ الروابط';
  });
}

/* =========================================================================================
   نافذة "إدارة روابط الفروض والاختبارات" — منبثقة مستقلة من لوحة تحكم الأستاذ
   بخلاف نافذة حصص الزوم، لا يوجد هنا اختيار درس ولا تكرار لكل فوج: ثلاثة أقسام فقط
   (الفصل الأول/الثاني/الثالث)، وكل فصل يحوي قائمة قابلة للتكرار من عناصر {عنوان + رابط}،
   لأن الفرض/الاختبار يخصّ كل التلاميذ معًا بغضّ النظر عن فوجهم.
   ========================================================================================= */
const EXAM_LINK_TRIMESTERS = [
  { key:'t1', label:'📘 الفصل الأول' },
  { key:'t2', label:'📗 الفصل الثاني' },
  { key:'t3', label:'📙 الفصل الثالث' }
];

/* يضيف صفًّا جديدًا (عنوان + رابط + زر حذف) داخل حاوية عناصر فصل معيّن */
function addExamLinkRow(container, title, link){
  const row = document.createElement('div');
  row.className = 'zoom-link-row exam-link-row';
  row.innerHTML = `
    <input type="text" class="zoom-form-input exam-link-title" placeholder="عنوان الفرض/الاختبار (مثال: الفرض الأول)" value="${escZoomText(title||'')}">
    <input type="text" class="zoom-form-input exam-link-url" placeholder="https://…" value="${escZoomText(link||'')}">
    <button type="button" class="zoom-link-remove-btn" title="حذف هذا العنصر">✕</button>`;
  row.querySelector('.zoom-link-remove-btn').addEventListener('click', ()=>{
    if(window.SoundFX) SoundFX.click();
    row.remove();
  });
  container.appendChild(row);
}

function openExamLinksManagerModal(){
  if(!fbReady){
    alert('Firebase غير مفعّل. لا يمكن حفظ روابط الفروض والاختبارات بدونه.');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'zoom-modal-overlay';
  overlay.innerHTML = `
    <div class="zoom-modal-popup">
      <div class="zoom-modal-header">
        <div class="zoom-modal-title">📝 إدارة روابط الفروض والاختبارات</div>
        <div class="zoom-modal-subtitle">موحّدة لجميع الأفواج — نفس الرابط يظهر لكل التلاميذ</div>
        <button type="button" class="zoom-modal-close" id="examLinksModalCloseBtn">✕</button>
      </div>
      <div class="zoom-modal-body" id="examLinksModalBody"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.remove(); });
  overlay.querySelector('#examLinksModalCloseBtn').addEventListener('click', ()=> overlay.remove());

  renderExamLinksManagerForm(overlay);
}

async function renderExamLinksManagerForm(overlay){
  const body = overlay.querySelector('#examLinksModalBody');
  body.innerHTML = '<div class="sf-label">جاري التحميل…</div>';

  await ExamLinks.load();
  await Locks.load();

  const sectionsHtml = EXAM_LINK_TRIMESTERS.map(t=> `
    <div class="zoom-form-divider"><span>${t.label}</span></div>
    <div class="zoom-form-group">
      <div class="zoom-link-rows" id="examRows-${t.key}"></div>
      <button type="button" class="zoom-add-link-btn" data-exam-add="${t.key}">+ إضافة فرض/اختبار آخر</button>
    </div>`).join('');

  body.innerHTML = `
    <div class="zoom-form-note">أضف عنوانًا ورابطًا لكل فرض أو اختبار جديد (رابط تيليجرام، PDF، أو أي رابط آخر) — بلا تكرار لكل فوج، فالرابط نفسه يظهر لكل التلاميذ فور فتح الفصل.
      <br>📨 روابط تيليجرام (مثل <bdi style="direction:ltr;display:inline-block">t.me/c/…</bdi>) تفتح للتلميذ في تطبيق تيليجرام مباشرة.
      <br>🔔 عند الضغط على "حفظ الروابط"، يصل إشعار فوري تلقائيًا لكل التلاميذ بكل فرض/اختبار جديد أضفته — دون أي خطوة إضافية.
      <br>💡 لا تنسَ فتح الفصل من قسم "فتح/إغلاق الفروض والاختبارات" حتى تصبح الروابط قابلة للفتح فعليًا عند التلميذ.</div>
    ${sectionsHtml}
    <button type="button" class="zoom-save-btn" id="examLinksSaveBtn">💾 حفظ الروابط</button>
    <div class="zoom-save-feedback" id="examLinksSaveFeedback"></div>`;

  /* تعبئة كل قسم بعناصره الحالية (عنصر واحد فارغ افتراضيًا إن لم يكن هناك شيء محفوظ بعد) */
  const originalItemsByTrimester = {};
  EXAM_LINK_TRIMESTERS.forEach(t=>{
    const container = body.querySelector(`#examRows-${t.key}`);
    const items = ExamLinks.getItems(t.key);
    originalItemsByTrimester[t.key] = items; /* نسخة أصلية قبل أي تعديل، لمقارنتها لاحقًا واكتشاف العناصر الجديدة فقط */
    if(items.length){
      items.forEach(it=> addExamLinkRow(container, it.title, it.link));
    } else {
      addExamLinkRow(container, '', '');
    }
  });

  body.querySelectorAll('[data-exam-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(window.SoundFX) SoundFX.click();
      const containerId = 'examRows-' + btn.getAttribute('data-exam-add');
      addExamLinkRow(body.querySelector('#'+containerId), '', '');
    });
  });

  body.querySelector('#examLinksSaveBtn').addEventListener('click', async ()=>{
    const saveBtn = body.querySelector('#examLinksSaveBtn');
    const feedback = body.querySelector('#examLinksSaveFeedback');

    saveBtn.disabled = true; saveBtn.textContent = '⏳ جاري الحفظ…';
    /* عناصر جديدة فعلاً (لم تكن موجودة قبل هذا الحفظ) لكل فصل — لإرسال إشعار فوري بكل واحد منها،
       نقارن حسب الرابط لأنه المعرّف الفعلي للعنصر (قد يتغيّر العنوان لعنصر قديم دون أن يكون "جديدًا") */
    const newlyAddedItems = []; // { title, trimesterLabel }
    try{
      for(const t of EXAM_LINK_TRIMESTERS){
        const container = body.querySelector(`#examRows-${t.key}`);
        const rows = Array.from(container.querySelectorAll('.exam-link-row'));
        const items = rows.map(row=> ({
          title: row.querySelector('.exam-link-title').value.trim(),
          link:  row.querySelector('.exam-link-url').value.trim()
        })).filter(it=> it.link);

        const before = originalItemsByTrimester[t.key] || [];
        items.forEach(it=>{
          if(!before.some(b=> b.link === it.link)){
            newlyAddedItems.push({ title: it.title || 'فرض/اختبار جديد', trimesterKey: t.key, trimesterLabel: t.label.replace(/^\S+\s/, '') });
          }
        });

        const res = await ExamLinks.setItems(t.key, items);
        if(!res || !res.ok) throw new Error((res && res.reason) || 'unknown');
      }

      /* إرسال إشعار فوري ومباشر لكل تلميذ عن كل فرض/اختبار جديد أُضيف الآن — دون أي خطوة يدوية إضافية.
         الصياغة تعكس فعليًا ما إذا كان فصله مفتوحًا للتلاميذ أم لا، حتى لا يظنّ التلميذ أنه متاح
         بينما الفصل ما زال مغلقًا. */
      let notifiedCount = 0;
      if(newlyAddedItems.length && typeof NotificationsSystem !== 'undefined'){
        for(const item of newlyAddedItems){
          const isOpen = Locks.isTrimesterOpen(item.trimesterKey);
          const details = isOpen
            ? `${item.trimesterLabel} — متاح الآن للتلاميذ`
            : `${item.trimesterLabel} — سيصبح متاحًا فور فتح الفصل من الأستاذ`;
          const sent = await NotificationsSystem.addNewContentAlert('exam', item.title, details);
          if(sent) notifiedCount++;
        }
      }

      if(window.SoundFX) SoundFX.correct();
      feedback.textContent = newlyAddedItems.length
        ? `✅ تم حفظ الروابط، وأُرسل إشعار فوري بـ${notifiedCount} فرض/اختبار جديد لكل التلاميذ.`
        : '✅ تم حفظ الروابط بنجاح — أصبحت متاحة فورًا للتلاميذ.';
      feedback.style.color = 'var(--sage-deep,#3F6350)';
    }catch(error){
      console.error('فشل حفظ روابط الفروض والاختبارات (تحقق من قواعد Firestore لمجموعة state):', error);
      if(typeof showFbPermissionNotice === 'function') showFbPermissionNotice('examLinks');
      feedback.textContent = '⚠️ تعذّر حفظ الروابط. راجع التنبيه الظاهر أعلى الصفحة.';
      feedback.style.color = '#b5432a';
    }
    saveBtn.disabled = false; saveBtn.textContent = '💾 حفظ الروابط';
  });
}

/* =========================================================================================
   نافذة تسجيل دخول التلميذ (شاشة ترحيب + نموذج برقم الهاتف مع استرجاع المعلومات المحفوظة)
   ========================================================================================= */
function setupLoginModal(){
  const welcomeStep   = document.getElementById('loginWelcomeStep');
  const formStep       = document.getElementById('loginFormStep');
  const formTitle      = document.getElementById('loginFormTitle');
  const formSub        = document.getElementById('loginFormSub');
  const phoneInput      = document.getElementById('loginPhoneInput');
  const firstNameInput  = document.getElementById('loginFirstNameInput');
  const lastNameInput   = document.getElementById('loginLastNameInput');
  const recalledBox     = document.getElementById('loginRecalledBox');
  const recalledName    = document.getElementById('loginRecalledName');
  const submitBtn       = document.getElementById('loginSubmitBtn');
  const msgBox          = document.getElementById('loginMsg');

  /* يحدّد الوضع الحالي للنموذج: 'signin' (دخول لحساب موجود فقط) أو 'signup' (إنشاء حساب جديد فقط) */
  let currentMode = 'signin';

  /* يفصل الاسم الكامل المحفوظ إلى اسم أول ولقب لتعبئة الخانتين تلقائيًا */
  function splitSavedName(fullName){
    const parts = (fullName||'').trim().split(/\s+/);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
  }

  /* تعبئة النموذج من آخر بيانات محفوظة محليًا على هذا الجهاز (إن وُجدت) */
  function fillFromLocalMemory(){
    const savedPhone = lsGet('remembered_phone');
    const savedName  = lsGet('remembered_name');
    if(savedPhone && savedName){
      const { first, last } = splitSavedName(savedName);
      phoneInput.value = savedPhone;
      firstNameInput.value = first;
      lastNameInput.value = last;
      recalledName.textContent = savedName;
      recalledBox.style.display = 'block';
      return true;
    }
    recalledBox.style.display = 'none';
    return false;
  }

  function clearFormFields(){
    phoneInput.value = ''; firstNameInput.value = ''; lastNameInput.value = '';
    recalledBox.style.display = 'none'; msgBox.textContent = '';
  }

  function openForm(mode){ /* mode: 'signin' | 'signup' */
    currentMode = mode;
    welcomeStep.style.display = 'none';
    formStep.style.display = 'block';
    msgBox.textContent = '';
    if(mode === 'signup'){
      formTitle.textContent = 'إنشاء حساب جديد';
      formSub.textContent = 'أدخل رقم هاتفك واسمك ولقبك لإرسال طلب تسجيل';
      clearFormFields();
    } else {
      formTitle.textContent = 'تسجيل الدخول';
      formSub.textContent = 'أدخل رقم هاتفك واسمك ولقبك، أو تحقق من معلوماتك المسترجَعة أدناه';
      fillFromLocalMemory();
    }
  }

  document.getElementById('loginGoSigninBtn').addEventListener('click', ()=> openForm('signin'));
  document.getElementById('loginGoSignupBtn').addEventListener('click', ()=> openForm('signup'));
  document.getElementById('loginBackToWelcomeLink').addEventListener('click', (e)=>{
    e.preventDefault();
    formStep.style.display = 'none';
    welcomeStep.style.display = 'block';
  });
  document.getElementById('loginNotMeLink').addEventListener('click', (e)=>{
    e.preventDefault();
    localStorage.removeItem('remembered_phone');
    localStorage.removeItem('remembered_name');
    clearFormFields();
  });

  submitBtn.addEventListener('click', async ()=>{
    const phone = phoneInput.value.trim();
    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    if(!phone){ alert('يرجى كتابة رقم الهاتف.'); return; }
    if(!firstName || !lastName){ alert('يرجى كتابة الاسم واللقب في الخانتين.'); return; }
    const name = firstName + ' ' + lastName;

    submitBtn.disabled = true; submitBtn.textContent = 'جارٍ التحقق…';
    msgBox.textContent = '';

    /* الوضعان منفصلان تمامًا: تسجيل الدخول لا يُنشئ أي طلب أبدًا،
       وإنشاء حساب جديد لا يُنشئ طلبًا مكرَّرًا لرقم هاتف مسجَّل من قبل */
    const res = (currentMode === 'signup')
      ? await Student.register(name, phone, null)
      : await Student.login(name, phone);

    submitBtn.disabled = false; submitBtn.textContent = 'دخول';

    if(!res.ok){ msgBox.textContent = 'تعذّر الاتصال بالمنصة، تحقق من إعداد Firebase.'; return; }

    if(res.status === 'not_found'){
      msgBox.textContent = '❌ لا يوجد حساب مسجَّل بهذا رقم الهاتف. إن كنت تلميذًا جديدًا، اضغط "رجوع" ثم اختر "إنشاء حساب جديد".';
      return;
    }
    if(res.status === 'already_exists'){
      msgBox.textContent = 'ℹ️ يوجد حساب مسجَّل بهذا رقم الهاتف من قبل. اضغط "رجوع" ثم اختر "تسجيل الدخول" بدلًا من إنشاء حساب جديد.';
      return;
    }

    /* نحفظ رقم الهاتف والاسم محليًا على هذا الجهاز لتُسترجَع تلقائيًا في المرة القادمة */
    lsSet('remembered_phone', phone); lsSet('remembered_name', res.fullName || name);

    if(res.status === 'pending'){ msgBox.textContent = '⏳ طلبك قيد المراجعة، يرجى الانتظار حتى يوافق الأستاذ أو المشرف.'; return; }
    if(res.status === 'rejected'){ msgBox.textContent = '❌ لم تتم الموافقة على طلبك. اضغط "رجوع" ثم اختر "إنشاء حساب جديد" لإعادة إرسال طلبك من جديد، أو تواصل مع الأستاذ.'; return; }
    document.getElementById('loginModal').classList.remove('show');
    if(window.SoundFX) SoundFX.login();
    renderWelcome();
  });

  /* عند فتح النافذة أول مرة: إن وُجدت معلومات محفوظة سابقًا نتخطى شاشة الترحيب ونعرض نموذج تسجيل الدخول مباشرة */
  if(fillFromLocalMemory()){
    currentMode = 'signin';
    welcomeStep.style.display = 'none';
    formStep.style.display = 'block';
    formTitle.textContent = 'تسجيل الدخول';
    formSub.textContent = 'أدخل رقم هاتفك واسمك ولقبك، أو تحقق من معلوماتك المسترجَعة أدناه';
  }
}

/* =========================================================================================
   الإقلاع
   ========================================================================================= */
document.addEventListener('DOMContentLoaded', async ()=>{
  /* تهيئة: تأكد من أن الـ hero يظهر افتراضياً (الشاشة الرئيسية) */
  const hero = document.querySelector('.hero');
  if(hero) hero.style.display = 'block';
  
  Screens.init();
  setupAdminLoginModal();

  if(!fbReady){
    document.getElementById('fbNotice').innerHTML = fbUnavailableNotice();
  }

  Locks.listen(()=>{
    if(document.getElementById('screen-lessons').style.display !== 'none') renderLessonsScreen();
    if(document.getElementById('screen-situation').style.display !== 'none') renderSituationPracticeTabs();
    if(document.getElementById('screen-irab').style.display !== 'none') renderIrabScreen();
    if(document.getElementById('screen-exams').style.display !== 'none') renderExamsScreen();
    if(document.getElementById('screen-leaderboard').style.display !== 'none') renderLeaderboardScreen();
    updateIrabHomeCardLock();
  });
  Locks.load().then(updateIrabHomeCardLock);

  /* ملاحظة: الاستماع اللحظي لطلبات التسجيل (Admin.listenPending) لم يعد يُفعَّل هنا —
     أصبح يبدأ فقط بعد نجاح تسجيل دخول الأستاذ (setupAdminLoginModal)، تفاديًا لاشتراك كل
     زائر للموقع في هذا الاستماع، وهو ما كان يُضاعِف استهلاك حصة القراءات بشكل كبير. */

  /* روابط حصص الزوم: تحميل أولي، ثم استماع لحظي — أي تحديث من الأستاذ ينعكس فورًا في صفحة
     الدرس المفتوحة حاليًا عند التلميذ دون الحاجة لإعادة تحميل الصفحة */
  ZoomLinks.load().then(()=>{
    if(window.currentOpenLessonId && document.getElementById('screen-lessonDetail').style.display !== 'none'){
      const lesson = window.LESSONS.find(l=>l.id===window.currentOpenLessonId);
      if(lesson && lesson.category!=='muktasabat') renderZoomGroupsBox(lesson);
    }
  });
  ZoomLinks.listen(()=>{
    if(window.currentOpenLessonId && document.getElementById('screen-lessonDetail').style.display !== 'none'){
      const lesson = window.LESSONS.find(l=>l.id===window.currentOpenLessonId);
      if(lesson && lesson.category!=='muktasabat') renderZoomGroupsBox(lesson);
    }
  });

  /* روابط الفروض والاختبارات: تحميل أولي، ثم استماع لحظي — أي رابط جديد يضيفه الأستاذ
     ينعكس فورًا في شاشة الفروض والاختبارات المفتوحة حاليًا عند التلميذ */
  ExamLinks.load().then(()=>{
    if(document.getElementById('screen-exams').style.display !== 'none') renderExamsScreen();
  });
  ExamLinks.listen(()=>{
    if(document.getElementById('screen-exams').style.display !== 'none') renderExamsScreen();
  });

  /* عدد التمارين اليومية المتاحة حاليًا: يُعرض كشارة صغيرة على بطاقة "تمارين يومية"
     بالصفحة الرئيسية. قراءة دورية (وليست بثًا لحظيًا onSnapshot) لنفس سبب توفير حصة
     Firestore المجانية اليومية الموضَّح أعلاه في Locks.listen — عدد التمارين لا يحتاج
     أصلاً لتحديث لحظي، فتكفي قراءة واحدة كل بضع دقائق. */
  if(fbReady){
    const refreshDailyBadge = ()=> db.collection('exams').where('category','==','daily').get().then(snap=>{
      const badge = document.getElementById('dailyExCountBadge');
      if(!badge) return;
      const n = snap.size;
      if(n > 0){
        badge.textContent = n;
        badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;margin-inline-start:6px;border-radius:999px;background:#C79A3D;color:#fff;font-size:12px;font-weight:700;vertical-align:middle;';
      } else {
        badge.style.display = 'none';
      }
    }).catch(()=>{ /* تجاهل الخطأ بصمت — تبقى الشارة مخفية */ });
    startVisibilityAwarePolling(refreshDailyBadge, 5 * 60 * 1000);
  }

  const resumed = await Student.resume();
  if(resumed){ renderWelcome(); }

  setupLoginModal();

  if(Student.status !== 'approved'){
    document.getElementById('loginModal').classList.add('show');
  }

  Screens.show('home');
});

/* =========================================================================================
   PWA: تسجيل Service Worker وزر التثبيت
   ========================================================================================= */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').then(reg=>{
      /* عند اكتشاف نسخة جديدة من الملفات على الخادم: نفعّلها فورًا ونُعيد تحميل الصفحة تلقائيًا،
         حتى لا يحتاج التلميذ أو الأستاذ أبدًا لحذف التطبيق أو مسح بياناته يدويًا */
      reg.addEventListener('updatefound', ()=>{
        const newWorker = reg.installing;
        if(!newWorker) return;
        newWorker.addEventListener('statechange', ()=>{
          if(newWorker.state === 'activated'){ location.reload(); }
        });
      });
      /* تحقق دوري من وجود تحديث كل مرة يُفتح فيها التطبيق */
      reg.update().catch(()=>{});
    }).catch(()=>{});
  });
  /* إن تغيّر الـ Service Worker المتحكّم (تحديث فعلي حدث)، أعد تحميل الصفحة مرة واحدة فقط */
  let reloadedOnce = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(reloadedOnce) return; reloadedOnce = true; location.reload();
  });
}
let deferredInstallPrompt = null;

/* إخفاء زر/صف "تثبيت التطبيق" نهائياً من الواجهة */
function hidePwaInstallButton(){
  const btn = document.getElementById('pwaInstallBtn');
  const row = btn ? btn.closest('.install-row') : document.querySelector('.install-row');
  if(row) row.style.display = 'none';
  else if(btn) btn.style.display = 'none';
}

/* هل التطبيق مثبّت فعلاً؟ (تخزين محلي، أو التشغيل حالياً بوضع standalone/PWA) */
function isPwaInstalled(){
  if(localStorage.getItem('pwaInstalled') === '1') return true;
  if(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  if(window.navigator.standalone === true) return true; // iOS Safari
  return false;
}

window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault(); deferredInstallPrompt = e;
});

/* المتصفح يطلق هذا الحدث فور اكتمال التثبيت فعلياً */
window.addEventListener('appinstalled', ()=>{
  localStorage.setItem('pwaInstalled', '1');
  hidePwaInstallButton();
});

document.addEventListener('DOMContentLoaded', ()=>{
  /* إن كان التطبيق مثبتاً مسبقاً على هذا الجهاز، أخفِ الزر فوراً ولا تُظهره مجدداً */
  if(isPwaInstalled()) hidePwaInstallButton();

  /* تثبيت التطبيق */
  const btn = document.getElementById('pwaInstallBtn');
  if(btn) btn.addEventListener('click', async ()=>{
    if(deferredInstallPrompt){
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      /* بعض المتصفحات لا تُطلق appinstalled فور القبول، فنحفظ الحالة هنا احتياطاً */
      if(choice && choice.outcome === 'accepted'){
        localStorage.setItem('pwaInstalled', '1');
        hidePwaInstallButton();
      }
    }
    else alert('لتثبيت التطبيق: افتح قائمة المتصفح واختر "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية".');
  });

  /* تهيئة الميزات الجديدة */
  if(typeof initWisdomBanner === 'function') setTimeout(initWisdomBanner, 500);
  if(typeof initNotificationsSystem === 'function') setTimeout(initNotificationsSystem, 500);
  if(typeof setupLessonLiveUpdates === 'function') setTimeout(setupLessonLiveUpdates, 500);
  /* خانة إحصائيات المنصّة (عدد التلاميذ/المتصلين الآن) أُلغيت نهائيًا: كانت تعمل عند كل
     تلميذ وتقرأ كل مستندات التلاميذ كل 30 ثانية، مما يستهلك سقف قراءات Firestore
     المجاني بسرعة كبيرة مع عدد كبير من التلاميذ. */

  /* تحديث لوحة التحكم لتشمل إدارة التلاميذ */
  const originalRenderAdminPanel = window.renderAdminPanel;
  if(typeof originalRenderAdminPanel === 'function'){
    window.renderAdminPanel = async function(){
      await originalRenderAdminPanel.call(this);
      if(typeof renderStudentManagementPanel === 'function'){
        setTimeout(() => renderStudentManagementPanel(), 300);
      }
    };
  }
});

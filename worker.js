/* =========================================================================================
   worker.js — بوّابة آمنة بين تطبيق "المعلّم الذكي" وواجهة Claude API
   ---------------------------------------------------------------------------------------
   لماذا هذا الملف ضروري؟
   تطبيق المعلّم الذكي (smart-teacher.html) يستدعي هذا الـ Worker عبر الدالة callClaude()
   بدل استدعاء api.anthropic.com مباشرة من المتصفح، حتى لا يظهر مفتاحك السري لـ Anthropic
   في كود الصفحة الذي يراه أي شخص يفحص الموقع. الـ Worker يحتفظ بالمفتاح بأمان على خوادم
   Cloudflare (كسرّ Secret)، ويكتفي بتمرير الطلب والرد بينك وبين Claude.

   ==================== خطوات النشر (٥ دقائق، مجانًا) ====================
   1) أنشئ حسابًا مجانيًا على https://dash.cloudflare.com (Workers & Pages)
   2) من التبويب "Workers & Pages" اضغط "Create" → "Create Worker"
   3) امسح الكود الافتراضي، والصق محتوى هذا الملف كاملاً، ثم اضغط "Deploy"
   4) من إعدادات الـ Worker → "Settings" → "Variables and Secrets" أضف سرًّا جديدًا:
        الاسم: ANTHROPIC_API_KEY
        القيمة: مفتاحك من https://console.anthropic.com (يبدأ بـ sk-ant-...)
      ثم احفظ (Save and Deploy).
   5) انسخ رابط الـ Worker (يظهر أعلى الصفحة، شكله:
        https://اسمك.حسابك.workers.dev/)
   6) افتح smart-teacher.html في المتصفح لأول مرة، وسيُطلب منك لصق هذا الرابط — الصقه واحفظ.

   ⚠️ تنبيه: فعّل حدًا شهريًا للإنفاق (Spending Limit) من لوحة تحكم Anthropic لتفادي أي
   استهلاك غير متوقع، وراقب الاستخدام دوريًا.
   ========================================================================================= */

export default {
  async fetch(request, env) {
    /* السماح بطلبات CORS من المتصفح (الصفحة تُستضاف على نطاق مختلف عن الـ Worker) */
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'الطريقة غير مسموحة، يُستخدم POST فقط.' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'لم يُضبط مفتاح ANTHROPIC_API_KEY بعد في إعدادات الـ Worker (Secrets).' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'جسم الطلب ليس JSON صالحًا.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    /* تمرير الطلب كما هو (model, max_tokens, system, messages) إلى Claude API الحقيقي،
       مع إضافة المفتاح السري من جهة الخادم فقط — لا يمر أبدًا عبر المتصفح. */
    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: body.model || 'claude-sonnet-5',
          max_tokens: body.max_tokens || 1000,
          system: body.system,
          messages: body.messages
        })
      });

      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'تعذّر الاتصال بخدمة Claude API: ' + (e && e.message || e) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};

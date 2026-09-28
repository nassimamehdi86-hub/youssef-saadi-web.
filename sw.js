/* =========================================================================================
   Service Worker — استراتيجية "الشبكة أولًا" (Network First)
   =========================================================================================
   كل ملفات التطبيق (HTML, CSS, JS, بيانات الدروس...) تُطلَب دائمًا من الإنترنت أولًا،
   فأي تحديث يرفعه الأستاذ/المشرف على GitHub يظهر تلقائيًا لكل التلاميذ عند فتح التطبيق
   من جديد، دون الحاجة لحذف التطبيق أو مسح بياناته يدويًا.
   يُستخدم التخزين المؤقت فقط كخطة بديلة عند انقطاع الإنترنت تمامًا (وضع عدم الاتصال).
   ========================================================================================= */

const CACHE_NAME = 'abou-chaker-lâabbadi-v11'; /* رُفع الرقم لأن ميزة "تحليل الدرس ومراجعة شاملة" أُلغيت وحُذفت نهائيًا */
const CORE_ASSETS = [
  './index.html', './style.css', './app.js', './lessons-data.js', './irab-data.js',
  './firebase-config.js', './manifest.json', './icon-192.png', './icon-512.png',
  './teacher-avatar.jpg', './teacher-watermark.jpg', './smart-teacher.html',
  './certificate-generator.js', './exercise-pdf-generator.js'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).catch(()=>{}));
  self.skipWaiting(); /* يفعّل النسخة الجديدة من الـ Service Worker فورًا، بلا انتظار إغلاق كل النوافذ */
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
  );
  self.clients.claim(); /* يتحكم فورًا بكل الصفحات المفتوحة دون الحاجة لإعادة تحميلها يدويًا */
});

self.addEventListener('fetch', (e)=>{
  if(e.request.method !== 'GET') return;

  /* مهم جدًا: نعترض فقط طلبات نفس الموقع (index.html, style.css, app.js...).
     أي طلب لموقع آخر (Firestore, Google Fonts, YouTube...) يجب أن يمر مباشرة للشبكة
     بدون أي تدخل من الـ Service Worker — لأن اعتراض اتصالات Firestore (وهي اتصالات
     طويلة ومستمرة تُستخدم للتحديث اللحظي onSnapshot) قد يكسرها أو يجعلها تعرض بيانات
     قديمة محفوظة بالخطأ في ذاكرة التخزين المؤقت لهذا العامل، وهذا كان على الأرجح سبب
     بقاء حالة الدرس "مقفلة" عند بعض التلاميذ حتى بعد فتحه فعليًا من الأستاذ. */
  const requestUrl = new URL(e.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(networkResponse => {
        /* نجح الاتصال بالشبكة: نُحدّث نسخة التخزين المؤقت بأحدث محتوى، ونُعيد النسخة الحديثة فورًا */
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)).catch(()=>{});
        return networkResponse;
      })
      .catch(() => caches.match(e.request)) /* فشل الاتصال (بلا إنترنت): نستخدم آخر نسخة محفوظة فقط عندئذ */
  );
});

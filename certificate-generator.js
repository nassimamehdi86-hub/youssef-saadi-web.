/* =========================================================================================
   مُولِّد «شهادة التقدير» عند إتمام اختبار الفهم بنتيجة جيدة أو ممتازة
   ---------------------------------------------------------------------------------------
   نفس الأسلوب المُثبَت أصلاً في تصدير الخريطة الذهنية وتمارين الدرس (exportMindmapPDF في
   app.js، وexercise-pdf-generator.js): تُبنى الشهادة كعناصر HTML فعلية بخط Cairo فقط
   (بلا أي letter-spacing على النص العربي) داخل حاوية خارج نطاق الشاشة (#certificatePrintArea)،
   ثم تُلتقط كصورة عبر html2canvas وتُدرَج في ملف PDF عبر jsPDF بتوجّه landscape (أفقي) —
   وهو الأنسب لتصميم شهادة تقدير كلاسيكية.
   نفس عنصر HTML المبني هنا يُستخدم أيضًا لمعاينة الشهادة مباشرة على الشاشة داخل نافذة منبثقة
   (Modal) قبل التنزيل، حتى يرى التلميذ شكلها النهائي بالضبط قبل الطباعة أو الحفظ.
   ========================================================================================= */

const CERT_PAGE_W = 1123; // عرض A4 أفقي (landscape) عند 96dpi (px)
const CERT_PAGE_H = 794;  // ارتفاع A4 أفقي عند 96dpi (px)

/**
 * تحويل نص عادي إلى HTML آمن (منع كسر بنية الشهادة عند وجود اسم يحتوي رموز مثل & أو <)
 */
function certEscapeHtml(str){
  return String(str==null ? '' : str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

/**
 * إرجاع حاوية الطباعة الخارجة عن نطاق الشاشة (تُنشأ إن لم تكن موجودة في index.html لأي سبب)
 */
function certGetPrintArea(){
  let area = document.getElementById('certificatePrintArea');
  if(!area){
    area = document.createElement('div');
    area.id = 'certificatePrintArea';
    area.style.cssText = 'position:fixed;top:0;left:-99999px;width:'+CERT_PAGE_W+'px;z-index:-1;background:#fff;visibility:visible;pointer-events:none;';
    document.body.appendChild(area);
  }
  return area;
}

/**
 * تنتظر تحميل مكتبتي html2canvas وjsPDF من الإنترنت، وتفشل برسالة عربية واضحة بعد مهلة معقولة
 */
function certWaitForLibs(timeoutMs = 10000){
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

/**
 * تضمن اكتمال تحميل خط Cairo فعليًا في المتصفح قبل التقاط الصورة، لتفادي أي خط احتياطي مؤقت
 */
async function certEnsureFontsLoaded(){
  if(!(document.fonts && document.fonts.load)) return;
  try{
    await Promise.all([
      document.fonts.load('900 30px Cairo'),
      document.fonts.load('800 18px Cairo'),
      document.fonts.load('700 14px Cairo'),
      document.fonts.load('600 12px Cairo'),
      document.fonts.load('400 12px Cairo')
    ]);
    if(document.fonts.ready) await document.fonts.ready;
  }catch(e){ /* لا نوقف التصدير أبدًا بسبب فشل تحميل خط واحد */ }
}

/**
 * تاريخ اليوم بصيغة عربية مقروءة، دون الاعتماد على toLocaleDateString (يختلف دعمها بين الأجهزة)
 */
function certTodayArabic(){
  const months = ['جانفي','فيفري','مارس','أفريل','ماي','جوان','جويلية','أوت','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const d = new Date();
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * عبارة التكريم حسب نسبة الإتقان — بنفس منطق مستويات نتيجة اختبار الفهم في app.js
 */
function certTierInfo(pct){
  if(pct >= 90){
    return {
      tier:'excellent', badge:'🏆',
      headline:'أداءٌ استثنائي يليق بالنجوم!',
      msg:'تفوّق واضح وإتقان يستحق كل الفخر — استمر بهذا التألق نحو القمة 🌟'
    };
  }
  return {
    tier:'good', badge:'🎖️',
    headline:'مجهودٌ رائع يستحق التقدير!',
    msg:'نتيجة جيدة جدًا تعكس جدّية والتزامًا حقيقيّين — واصل بنفس هذا العزم 💪'
  };
}

/**
 * بناء محتوى الشهادة (HTML) — نفس العنصر يُستخدم للمعاينة على الشاشة وللالتقاط والتصدير كـPDF
 */
function buildCertificateHTML(lesson, studentName, pct){
  const info = certTierInfo(pct);
  const safeName = certEscapeHtml(studentName || 'الطالب المجتهد');
  const safeLesson = certEscapeHtml(lesson.title || '');
  return `
  <div class="cert-page">
    <div class="cert-frame">
      <span class="cert-corner cert-corner-tl"></span>
      <span class="cert-corner cert-corner-tr"></span>
      <span class="cert-corner cert-corner-bl"></span>
      <span class="cert-corner cert-corner-br"></span>

      <div class="cert-badge-ribbon">${info.badge}</div>

      <div class="cert-head">
        <img class="cert-logo" src="icon-512.png" alt="">
        <div class="cert-platform">منصة الأستاذ يوسف سعيدي</div>
        <div class="cert-subject">لتدريس اللغة العربية — التعليم المتوسط</div>
      </div>

      <div class="cert-title">✦ شهادة تقدير ✦</div>
      <div class="cert-headline">${info.headline}</div>

      <div class="cert-body">
        <div class="cert-line">تشهد المنصّة بأنّ الطالب(ة)</div>
        <div class="cert-student-name">${safeName}</div>
        <div class="cert-line">قد أتمّ(ت) بنجاحٍ اختبارَ الفهم الخاصّ بدرس</div>
        <div class="cert-lesson-title">« ${safeLesson} »</div>
        <div class="cert-score-row">
          <span class="cert-score-label">بنسبة إتقان</span>
          <span class="cert-score-value">${pct}%</span>
        </div>
        <div class="cert-msg">${info.msg}</div>
      </div>

      <div class="cert-foot">
        <div class="cert-foot-col cert-foot-date">
          <div class="cert-foot-label">التاريخ</div>
          <div class="cert-foot-value">${certTodayArabic()}</div>
        </div>
        <div class="cert-foot-col cert-foot-seal">
          <div class="cert-seal">✔</div>
        </div>
        <div class="cert-foot-col cert-foot-sign">
          <img class="cert-teacher-photo" src="teacher-avatar.jpg" alt="" onerror="this.style.display='none'">
          <div class="cert-foot-label">الأستاذ</div>
          <div class="cert-foot-value">يوسف سعيدي</div>
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * فتح نافذة معاينة الشهادة على الشاشة، مع زرّي تنزيل/طباعة وإغلاق
 */
function openCertificateModal(lesson, pct){
  const studentName = (typeof Student !== 'undefined' && Student.fullName) ? Student.fullName : 'الطالب المجتهد';

  const overlay = document.createElement('div');
  overlay.className = 'cert-modal-overlay';
  overlay.innerHTML = `
    <div class="cert-modal-box">
      <button class="cert-modal-close" aria-label="إغلاق">✕</button>
      <div class="cert-modal-scroll">
        <div class="cert-preview-wrap">${buildCertificateHTML(lesson, studentName, pct)}</div>
      </div>
      <div class="cert-modal-actions">
        <button class="cert-download-btn" id="certDownloadBtn">🖨️ تنزيل / طباعة الشهادة</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  overlay.querySelector('.cert-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });

  overlay.querySelector('#certDownloadBtn').addEventListener('click', (e)=>{
    exportCertificatePDF(lesson, studentName, pct, e.currentTarget);
  });
}

/**
 * التقاط الشهادة كصورة وتصديرها كملف PDF أفقي (landscape) وتنزيله مباشرة على جهاز التلميذ
 */
function exportCertificatePDF(lesson, studentName, pct, btnEl){
  const area = certGetPrintArea();
  area.innerHTML = buildCertificateHTML(lesson, studentName, pct);

  const originalBtnHTML = btnEl ? btnEl.innerHTML : '';
  if(btnEl){ btnEl.innerHTML = '⏳ جارٍ التحضير...'; btnEl.disabled = true; }

  (async ()=>{
    const forceCleanClone = (clonedDoc)=>{
      if(clonedDoc.body){ clonedDoc.body.style.background = '#ffffff'; }
      if(clonedDoc.documentElement){ clonedDoc.documentElement.style.background = '#ffffff'; }
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
        scale, useCORS:true, allowTaint:true, backgroundColor:'#ffffff', logging:false,
        onclone: forceCleanClone
      });
    }

    try{
      await certWaitForLibs();
      await certEnsureFontsLoaded();
      await new Promise(r=> setTimeout(r, 150));

      const pageEl = area.querySelector('.cert-page');
      const naturalW = pageEl.scrollWidth || CERT_PAGE_W;
      const naturalH = pageEl.scrollHeight || CERT_PAGE_H;
      const MAX_DIM = 4000;
      let scale = 2;
      if(naturalW*scale > MAX_DIM || naturalH*scale > MAX_DIM){
        scale = Math.max(1, Math.min(scale, MAX_DIM / Math.max(naturalW, naturalH)));
      }

      let canvas;
      try{
        canvas = await captureWithScale(pageEl, scale);
      }catch(innerErr){
        console.warn('exportCertificatePDF: retrying with scale=1 after error:', innerErr);
        canvas = await captureWithScale(pageEl, 1);
      }

      if(!canvas || !canvas.width || !canvas.height){
        throw new Error('تعذّر تجهيز صورة الشهادة (أبعاد فارغة). أعد المحاولة.');
      }

      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('l', 'mm', 'a4');
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
        throw new Error('تعذّر حساب أبعاد ملف الشهادة بشكل صحيح. أعد المحاولة.');
      }

      pdf.addImage(imgData, 'JPEG', x, y, imgWidth, imgHeight);
      pdf.save(`شهادة تقدير - ${lesson.title} - ${studentName}.pdf`);
    }catch(err){
      console.error('exportCertificatePDF failed:', err);
      alert((err && err.message) ? err.message : 'تعذّر إنشاء الشهادة. تأكد من اتصالك بالإنترنت ثم حاول مجددًا.');
    }finally{
      area.innerHTML = '';
      if(btnEl){ btnEl.innerHTML = originalBtnHTML; btnEl.disabled = false; }
    }
  })();
}

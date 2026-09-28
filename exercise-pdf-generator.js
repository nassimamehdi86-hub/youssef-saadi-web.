/* =========================================================================================
   مُولِّد PDF تمارين الدرس والحل النموذجي
   ---------------------------------------------------------------------------------------
   يُبنى محتوى كل ملف كعناصر HTML فعلية (بخط Cairo، بلا أي letter-spacing) داخل حاوية خارج
   نطاق الشاشة المرئية (#exercisePrintArea)، ثم تُلتقط كصورة عبر html2canvas وتُدرَج في ملف
   PDF عبر jsPDF — تمامًا بنفس الأسلوب المُثبَت أصلاً في تصدير الخريطة الذهنية (exportMindmapPDF
   في app.js). هذا يضمن رسم الحروف العربية متصلة وسليمة كما يراها المتصفح تمامًا، بدل استخدام
   jsPDF.text() مباشرة الذي يعتمد خط Helvetica الافتراضي غير الداعم للعربية إطلاقًا وينتج رموزًا
   عشوائية غير مقروءة (المشكلة الأصلية).
   بخلاف الخريطة الذهنية (صفحة واحدة دائمًا)، تمارين الدرس قد تطول، لذا يقسّم هذا الملف المحتوى
   إلى "كتل" ذرّية (سؤال واحد/زوج مستخرج واحد/عنصر إعراب واحد...) ثم يوزّعها على عدّة صفحات A4
   بحيث لا تُقطع أي كتلة أبدًا بين صفحتين.
   ========================================================================================= */

const EP_PAGE_W = 794;   // عرض A4 عند 96dpi (px) — نفس القيمة المعتمدة لطباعة الخريطة الذهنية
const EP_PAGE_H = 1123;  // ارتفاع A4 عند 96dpi (px)
const EP_PAGE_PAD_V = 30; // padding-top/bottom لكل صفحة، يطابق .ep-page في style.css
const EP_HEADER_MARGIN = 14; // margin-bottom لـ .ep-header-wrap في style.css
const EP_BLOCK_MARGIN = 10;  // margin-bottom لـ .ep-block في style.css
const EP_FOOTER_RESERVE = 22; // مساحة محجوزة أسفل كل صفحة لتذييل رقم الصفحة

/**
 * تحويل نص عادي إلى HTML آمن (لمنع كسر بنية الصفحة عند وجود رموز مثل & أو < في محتوى الدرس)
 */
function epEscapeHtml(str){
  return String(str==null ? '' : str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

/**
 * إرجاع حاوية الطباعة الخارجة عن نطاق الشاشة (تُنشأ إن لم تكن موجودة في index.html لأي سبب)
 */
function epGetPrintArea(){
  let area = document.getElementById('exercisePrintArea');
  if(!area){
    area = document.createElement('div');
    area.id = 'exercisePrintArea';
    area.style.cssText = 'position:fixed;top:0;left:-99999px;width:794px;z-index:-1;background:#fff;visibility:visible;pointer-events:none;';
    document.body.appendChild(area);
  }
  return area;
}

/**
 * تنتظر تحميل مكتبتي html2canvas وjsPDF من الإنترنت، وتفشل برسالة عربية واضحة بعد مهلة معقولة
 */
async function epWaitForLibs(timeoutMs = 10000){
  const start = Date.now();
  while(true){
    const ready = (typeof html2canvas !== 'undefined') && window.jspdf && window.jspdf.jsPDF;
    if(ready) return;
    if(Date.now() - start > timeoutMs){
      throw new Error('تعذّر تحميل مكوّنات إنشاء PDF من الإنترنت. تأكد من اتصالك، ومن أن أي برنامج حجب إعلانات أو جدار حماية للشبكة لا يمنع تحميل ملفات جافاسكريبت خارجية، ثم أعد المحاولة.');
    }
    await new Promise(r=> setTimeout(r, 200));
  }
}

/**
 * تضمن اكتمال تحميل خط Cairo فعليًا في المتصفح قبل أي التقاط صورة
 */
async function epEnsureFontsLoaded(){
  if(!(document.fonts && document.fonts.load)) return;
  try{
    await Promise.all([
      document.fonts.load('900 15px Cairo'),
      document.fonts.load('800 13px Cairo'),
      document.fonts.load('700 11px Cairo'),
      document.fonts.load('600 10px Cairo'),
      document.fonts.load('400 10px Cairo')
    ]);
    if(document.fonts.ready) await document.fonts.ready;
  }catch(e){
    /* لا نوقف التصدير أبدًا بسبب فشل تحميل خط واحد — نتابع بأفضل خط متاح */
  }
}

function epIgnoreFloatingBackgrounds(el){
  if(!el || !el.classList) return false;
  return el.classList.contains('teacher-watermark') || el.classList.contains('islamic-pattern');
}

function epForceCleanClone(clonedDoc){
  clonedDoc.querySelectorAll('.teacher-watermark, .islamic-pattern').forEach(n=> n.remove());
  if(clonedDoc.body) clonedDoc.body.style.background = '#ffffff';
  if(clonedDoc.documentElement) clonedDoc.documentElement.style.background = '#ffffff';
  /* html2canvas يرسم الصفحة داخل iframe منفصل داخليًا، وقد لا يكون تحميل الخطوط فيه متزامنًا
     مع الصفحة الأصلية، فتظهر الحروف العربية مفكّكة. ننتظر هنا صراحةً اكتمال تحميل خطوط
     المستند المستنسخ نفسه، مع مهلة قصوى احترازية حتى لا يتعلّق التصدير للأبد. */
  if(clonedDoc.fonts && clonedDoc.fonts.ready){
    return Promise.race([ clonedDoc.fonts.ready, new Promise(resolve=> setTimeout(resolve, 1500)) ]);
  }
  return Promise.resolve();
}

async function epCaptureWithScale(el, scale){
  return html2canvas(el, {
    scale,
    useCORS:true,
    allowTaint:true,
    backgroundColor:'#ffffff',
    logging:false,
    ignoreElements: epIgnoreFloatingBackgrounds,
    onclone: epForceCleanClone
  });
}

/**
 * تلتقط عنصر صفحة واحدة كصورة، مع تحجيم آمن حسب أبعاده الفعلية (لا يتجاوز حدًا أقصى آمنًا
 * لأبعاد الـ canvas يتوافق مع أضعف متصفحات الجوّال) ومحاولة احتياطية بمقياس أقل عند الفشل
 */
async function epCapturePage(pageEl){
  const naturalW = pageEl.scrollWidth || EP_PAGE_W;
  const naturalH = pageEl.scrollHeight || EP_PAGE_H;
  const MAX_DIM = 4000;
  let scale = 2;
  if(naturalW*scale > MAX_DIM || naturalH*scale > MAX_DIM){
    scale = Math.max(1, Math.min(scale, MAX_DIM / Math.max(naturalW, naturalH)));
  }
  try{
    return await epCaptureWithScale(pageEl, scale);
  }catch(innerErr){
    console.warn('epCapturePage: retrying with scale=1 after error:', innerErr);
    return await epCaptureWithScale(pageEl, 1);
  }
}

/**
 * المحرّك العام: يوزّع مجموعة "كتل" HTML (كل كتلة سؤال/عنصر واحد لا يُقطع أبدًا بين صفحتين)
 * على عدّة صفحات A4 حسب الارتفاع الفعلي المُقاس في المتصفح، ثم يلتقط كل صفحة على حدة ويضيفها
 * إلى ملف الـ PDF مع ترويسة (في الصفحة الأولى فقط) وتذييل "الصفحة x من y" في كل صفحة.
 */
async function epRenderBlocksToPdf(pdf, { headerHtml, blocks, footerNote }){
  const area = epGetPrintArea();

  /* ===== المرحلة ١: قياس ارتفاع كل كتلة فعليًا بعرضها مرة واحدة في تدفّق واحد متواصل ===== */
  area.innerHTML = `<div class="ep-page">${headerHtml}${blocks.map(b=>`<div class="ep-block">${b}</div>`).join('')}</div>`;
  await epEnsureFontsLoaded();
  await new Promise(r=> setTimeout(r, 60));

  const measureRoot = area.querySelector('.ep-page');
  const headerEl = measureRoot.querySelector('.ep-header-wrap');
  const headerH = headerEl ? (headerEl.offsetHeight + EP_HEADER_MARGIN) : 0;
  const blockEls = Array.from(measureRoot.querySelectorAll('.ep-block'));
  const blockHeights = blockEls.map(el=> el.offsetHeight + EP_BLOCK_MARGIN);

  /* ===== المرحلة ٢: توزيع الكتل على صفحات حسب المساحة المتاحة فعليًا في كل صفحة ===== */
  const usableH = EP_PAGE_H - (EP_PAGE_PAD_V * 2) - EP_FOOTER_RESERVE;
  const pages = [];
  let cur = [];
  let curH = 0;
  let isFirstPage = true;
  blockHeights.forEach((h, i)=>{
    const budget = usableH - (isFirstPage ? headerH : 0);
    if(cur.length > 0 && (curH + h) > budget){
      pages.push({ blockIdx: cur, isFirst: isFirstPage });
      cur = [];
      curH = 0;
      isFirstPage = false;
    }
    cur.push(i);
    curH += h;
  });
  if(cur.length || !pages.length) pages.push({ blockIdx: cur, isFirst: isFirstPage });

  /* ===== المرحلة ٣: بناء كل صفحة فعليًا (بترويستها/تذييلها الصحيحين) والتقاطها وإدراجها ===== */
  const total = pages.length;
  for(let p=0; p<total; p++){
    const pg = pages[p];
    const bodyHtml = pg.blockIdx.map(i=> `<div class="ep-block">${blocks[i]}</div>`).join('');
    const footerHtml = `<div class="ep-footer">${epEscapeHtml(footerNote)} — الصفحة ${p+1} من ${total}</div>`;
    area.innerHTML = `<div class="ep-page">${pg.isFirst ? headerHtml : ''}${bodyHtml}${footerHtml}</div>`;
    await epEnsureFontsLoaded();
    await new Promise(r=> setTimeout(r, 60));

    const pageEl = area.querySelector('.ep-page');
    const canvas = await epCapturePage(pageEl);
    if(!canvas || !canvas.width || !canvas.height){
      throw new Error('تعذّر تجهيز إحدى صفحات الملف (أبعاد فارغة). أعد فتح الدرس وحاول مجددًا.');
    }

    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let imgWidth = pageWidth;
    let imgHeight = (canvas.height * imgWidth) / canvas.width;
    if(imgHeight > pageHeight){
      /* احتياط: كتلة استثنائية الطول تجاوزت مساحة صفحة كاملة — نصغّرها لتبقى مرئية بالكامل
         بدل أن يُقتطع أسفلها خارج حدود الصفحة */
      imgHeight = pageHeight;
      imgWidth = (canvas.width * imgHeight) / canvas.height;
    }
    if(![imgWidth, imgHeight].every(Number.isFinite)){
      throw new Error('تعذّر حساب أبعاد إحدى صفحات الملف بشكل صحيح. أعد فتح الدرس وحاول مجددًا.');
    }
    const x = (pageWidth - imgWidth) / 2;

    if(p > 0) pdf.addPage();
    pdf.addImage(imgData, 'JPEG', x, 0, imgWidth, imgHeight);
  }

  area.innerHTML = '';
}

/**
 * ترويسة موحّدة لأعلى الصفحة الأولى فقط (تمارين بالذهبي، حل نموذجي بالأخضر)
 */
function epBuildHeader(theme, bannerText, lesson, noteText){
  return `<div class="ep-header-wrap">
    <div class="ep-header theme-${theme}"><div class="ep-header-title">${epEscapeHtml(bannerText)}</div></div>
    <div class="ep-lesson-title">📚 ${epEscapeHtml(lesson.title||'')}</div>
    ${noteText ? `<div class="ep-note">${epEscapeHtml(noteText)}</div>` : ''}
  </div>`;
}

/**
 * بناء كتل HTML لملف "التمارين" (بدون حلول — بمساحات/جداول فارغة للكتابة اليدوية)
 */
function epBuildExerciseBlocks(exerciseData){
  const blocks = [];
  (exerciseData.sections || []).forEach(section=>{
    let sectionHead = `<div class="ep-section-title theme-gold">${epEscapeHtml(section.title||'')}</div>`;
    if(section.instructions) sectionHead += `<div class="ep-section-instr">${epEscapeHtml(section.instructions)}</div>`;

    if(section.type === 'fill' && Array.isArray(section.passage)){
      let html = sectionHead;
      html += `<div class="ep-q">${section.passage.map(tok=> tok.blank ? '<span class="ep-blank"></span>' : epEscapeHtml(tok.text||'')).join('')}</div>`;
      blocks.push(html);
    }
    else if(section.type === 'fill'){
      blocks.push(sectionHead);
      (section.items||[]).forEach((item, idx)=>{
        blocks.push(`<div class="ep-q">${idx+1}) ${epEscapeHtml(item.before||'')}<span class="ep-blank"></span>${epEscapeHtml(item.after||'')}</div>`);
      });
    }
    else if(section.type === 'extract'){
      const rows = section.pairs ? section.pairs.length : 5;
      let html = sectionHead;
      if(section.extractInstructions) html += `<div class="ep-section-instr">${epEscapeHtml(section.extractInstructions)}</div>`;
      html += `<div class="ep-source">${epEscapeHtml((section.sourceText||'').replace(/<br\s*\/?>/gi,'\n'))}</div>`;
      html += `<table class="ep-table"><thead><tr><th>المعطوف عليه</th><th>حرف العطف</th><th>المعطوف</th></tr></thead><tbody>`;
      for(let i=0;i<rows;i++) html += `<tr><td></td><td></td><td></td></tr>`;
      html += `</tbody></table>`;
      /* نص المصدر والجدول يبقيان كتلة واحدة مترابطة حتى لا يُفصلا بين صفحتين */
      blocks.push(html);
      if((section.irabItems||[]).length){
        if(section.irabInstructions) blocks.push(`<div class="ep-section-instr">${epEscapeHtml(section.irabInstructions)}</div>`);
        section.irabItems.forEach((item, idx)=>{
          blocks.push(`<div class="ep-word">${idx+1}) ${epEscapeHtml(item.word||'')}</div><div class="ep-lines"><div class="ep-line"></div><div class="ep-line"></div><div class="ep-line"></div><div class="ep-line"></div></div>`);
        });
      }
    }
    else if(['irab','term','sentence'].includes(section.type)){
      blocks.push(sectionHead);
      if(section.type === 'sentence'){
        blocks.push(`<div class="ep-answer-text">هذا القسم يتطلب حلولاً فردية — أجب بجملة من إنشائك في ورقة إضافية.</div>`);
      } else {
        (section.items||[]).forEach((item, idx)=>{
          const label = item.word || item.term || '';
          const lineCount = section.type === 'irab' ? 4 : 2;
          let lines = '';
          for(let l=0;l<lineCount;l++) lines += `<div class="ep-line"></div>`;
          blocks.push(`<div class="ep-word">${idx+1}) ${epEscapeHtml(label)}</div><div class="ep-lines">${lines}</div>`);
        });
      }
    }
  });
  return blocks;
}

/**
 * بناء كتل HTML لملف "الحل النموذجي" (بالإجابات الصحيحة كاملة)
 */
function epBuildAnswerKeyBlocks(exerciseData){
  const blocks = [];
  (exerciseData.sections || []).forEach(section=>{
    const sectionHead = `<div class="ep-section-title theme-green">${epEscapeHtml(section.title||'')}</div>`;

    if(section.type === 'fill' && Array.isArray(section.passage)){
      blocks.push(sectionHead);
      const html = section.passage.map(tok=> tok.blank ? `<span class="ep-answer">${epEscapeHtml(tok.answer||'')}</span>` : epEscapeHtml(tok.text||'')).join('');
      blocks.push(`<div class="ep-q">${html}</div>`);
    }
    else if(section.type === 'fill'){
      blocks.push(sectionHead);
      (section.items||[]).forEach((item, idx)=>{
        blocks.push(`<div class="ep-q">${idx+1}) ${epEscapeHtml(item.before||'')} <span class="ep-answer">${epEscapeHtml(item.answer||'')}</span> ${epEscapeHtml(item.after||'')}</div>`);
      });
    }
    else if(section.type === 'extract'){
      blocks.push(`${sectionHead}<div class="ep-section-instr">الحالات المستخرجة من النص:</div>`);
      (section.pairs||[]).forEach((pair, idx)=>{
        blocks.push(`<div class="ep-pair">${idx+1}) المعطوف عليه: «${epEscapeHtml(pair.before)}» — حرف العطف: «${epEscapeHtml(pair.conj)}» — المعطوف: «${epEscapeHtml(pair.after)}»</div>`);
      });
      if((section.irabItems||[]).length){
        blocks.push(`<div class="ep-section-instr">${epEscapeHtml(section.irabInstructions||'أعرب ما تحته خط:')}</div>`);
        section.irabItems.forEach((item, idx)=>{
          blocks.push(`<div class="ep-word">${idx+1}) "${epEscapeHtml(item.word||'')}"</div><div class="ep-answer-label theme-green">الإعراب:</div><div class="ep-answer-text">${epEscapeHtml(item.answer||'')}</div>`);
        });
      }
    }
    else if(section.type === 'irab' || section.type === 'term'){
      blocks.push(sectionHead);
      const labelTxt = section.type === 'irab' ? 'الإعراب' : 'المعنى';
      (section.items||[]).forEach((item, idx)=>{
        const label = item.word || item.term || '';
        blocks.push(`<div class="ep-word">${idx+1}) "${epEscapeHtml(label)}"</div><div class="ep-answer-label theme-green">${labelTxt}:</div><div class="ep-answer-text">${epEscapeHtml(item.answer||'')}</div>`);
      });
    }
    else if(section.type === 'sentence'){
      blocks.push(`${sectionHead}<div class="ep-answer-text">ملاحظة: هذا القسم يتطلب حلولاً فردية. الحل النموذجي يظهر أمثلة على الاستخدام الصحيح.</div>`);
    }
  });
  return blocks;
}

/**
 * إنشاء ملف PDF للتمارين (بدون الحلول) — بمساحات فارغة للكتابة اليدوية
 */
async function generateExercisePDF(lesson, exerciseData){
  try{
    await epWaitForLibs();
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const headerHtml = epBuildHeader(
      'gold',
      'منصة الأستاذ يوسف سعدي — تمارين الدرس',
      lesson,
      'اكتب إجابتك يدويًا في المسافات المتروكة أسفل كل سؤال — لا تتردد في الاستعانة بملفات الدرس والفيديوهات.'
    );
    const blocks = epBuildExerciseBlocks(exerciseData);
    await epRenderBlocksToPdf(pdf, { headerHtml, blocks, footerNote: 'منصة الأستاذ يوسف سعدي' });
    pdf.save(`${(lesson.title||'تمرين').replace(/\s+/g, '_')}_تمارين.pdf`);
    return { ok: true };
  }
  catch(err){
    console.error('generateExercisePDF error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * إنشاء ملف PDF للحل النموذجي (Answer Key)
 */
async function generateAnswerKeyPDF(lesson, exerciseData){
  try{
    await epWaitForLibs();
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const headerHtml = epBuildHeader(
      'green',
      'منصة الأستاذ يوسف سعدي — الحل النموذجي',
      lesson,
      'الحل النموذجي الصحيح — استخدمه بعد محاولة حل التمارين بنفسك.'
    );
    const blocks = epBuildAnswerKeyBlocks(exerciseData);
    await epRenderBlocksToPdf(pdf, { headerHtml, blocks, footerNote: 'منصة الأستاذ يوسف سعدي' });
    pdf.save(`${(lesson.title||'تمرين').replace(/\s+/g, '_')}_الحل_النموذجي.pdf`);
    return { ok: true };
  }
  catch(err){
    console.error('generateAnswerKeyPDF error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * إظهار أزرار تنزيل PDF بجانب نتيجة التمرين (تُستدعى عند إنهاء التمرين مباشرة، وأيضًا عند
 * كل عودة لاحقة لصفحة الدرس بعد اجتيازه — انظر renderLessonExercisesBox في app.js)
 */
function addPdfDownloadButtons(lesson, exerciseData, containerEl){
  if(!containerEl) return;

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = `
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 16px;
    flex-wrap: wrap;
  `;

  // زر تنزيل التمارين
  const exerciseBtn = document.createElement('button');
  exerciseBtn.textContent = '📄 تحميل التمارين (بدون حل)';
  exerciseBtn.style.cssText = `
    padding: 10px 16px;
    background: linear-gradient(160deg, #ffc107, #ff9800);
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: 700;
    font-size: 12px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(169, 127, 42, 0.3);
    transition: all 0.3s ease;
  `;

  exerciseBtn.addEventListener('mouseover', ()=>{
    exerciseBtn.style.transform = 'translateY(-2px)';
    exerciseBtn.style.boxShadow = '0 6px 16px rgba(169, 127, 42, 0.4)';
  });

  exerciseBtn.addEventListener('mouseout', ()=>{
    exerciseBtn.style.transform = 'translateY(0)';
    exerciseBtn.style.boxShadow = '0 4px 12px rgba(169, 127, 42, 0.3)';
  });

  // زر تنزيل الحل النموذجي
  const answerKeyBtn = document.createElement('button');
  answerKeyBtn.textContent = '🔑 تحميل الحل النموذجي';
  answerKeyBtn.style.cssText = `
    padding: 10px 16px;
    background: linear-gradient(160deg, #4caf50, #45a049);
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: 700;
    font-size: 12px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
    transition: all 0.3s ease;
  `;

  answerKeyBtn.addEventListener('mouseover', ()=>{
    answerKeyBtn.style.transform = 'translateY(-2px)';
    answerKeyBtn.style.boxShadow = '0 6px 16px rgba(76, 175, 80, 0.4)';
  });

  answerKeyBtn.addEventListener('mouseout', ()=>{
    answerKeyBtn.style.transform = 'translateY(0)';
    answerKeyBtn.style.boxShadow = '0 4px 12px rgba(76, 175, 80, 0.3)';
  });

  /* الزرّان يتشاركان نفس حاوية الطباعة الخارجة عن الشاشة (#exercisePrintArea)، لذا نعطّل
     كليهما أثناء أي عملية إنشاء ملف واحدة لتفادي أي تضارب بينهما لو ضُغط عليهما معًا */
  function setBothDisabled(disabled){
    exerciseBtn.disabled = disabled;
    answerKeyBtn.disabled = disabled;
  }

  exerciseBtn.addEventListener('click', async ()=>{
    setBothDisabled(true);
    exerciseBtn.textContent = '⏳ جاري إنشاء الملف…';
    const result = await generateExercisePDF(lesson, exerciseData);
    exerciseBtn.textContent = result.ok ? '✅ تم التحميل!' : '❌ خطأ في التحميل';
    setTimeout(()=>{
      setBothDisabled(false);
      exerciseBtn.textContent = '📄 تحميل التمارين (بدون حل)';
    }, 2000);
  });

  answerKeyBtn.addEventListener('click', async ()=>{
    setBothDisabled(true);
    answerKeyBtn.textContent = '⏳ جاري إنشاء الملف…';
    const result = await generateAnswerKeyPDF(lesson, exerciseData);
    answerKeyBtn.textContent = result.ok ? '✅ تم التحميل!' : '❌ خطأ في التحميل';
    setTimeout(()=>{
      setBothDisabled(false);
      answerKeyBtn.textContent = '🔑 تحميل الحل النموذجي';
    }, 2000);
  });

  btnContainer.appendChild(exerciseBtn);
  btnContainer.appendChild(answerKeyBtn);
  containerEl.appendChild(btnContainer);
}

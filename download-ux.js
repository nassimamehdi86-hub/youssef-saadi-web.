/* =========================================================================================
   download-ux.js — نظام تحميل موحّد لكل الملفات في المنصة
   بدل الحفظ المباشر بصمت في الهاتف: تظهر نافذة "✅ اكتمل التحميل" (اسم الملف + حجمه)
   مع زر «📂 فتح الملف» (عارض داخل التطبيق لملفات PDF والصور) وزر «💾 حفظ في الهاتف».
   يعترض تلقائيًا كل تحميل يتم عبر رابط <a download> بمحتوى blob:/data: (ومنها pdf.save() في jsPDF
   المستعمل في الخريطة الذهنية والشهادة وتمارين الدرس وملف التلاميذ CSV) — فأي تحميل جديد يُضاف
   لاحقًا في المنصة يحصل على نفس التجربة دون أي تعديل إضافي.
   للاستعمال اليدوي:  DownloadUX.deliver(blob, 'اسم-الملف.pdf')
   ========================================================================================= */
(function(){
  'use strict';
  let bypass = false;

  function fmtSize(n){ return n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1, Math.round(n/1024))+' KB'; }

  /* حفظ فعلي في الهاتف (تجاوز الاعتراض) */
  function saveBlob(blob, name){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file';
    document.body.appendChild(a);
    bypass = true;
    try{ a.click(); } finally { bypass = false; }
    a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 60000);
  }

  function loadPdfJs(){
    if(window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if(window.__pdfJsLoading) return window.__pdfJsLoading;
    window.__pdfJsLoading = new Promise((res, rej)=>{
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      sc.onload = ()=>{ window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
      sc.onerror = ()=>{ window.__pdfJsLoading = null; rej(new Error('pdfjs-load-failed')); };
      document.head.appendChild(sc);
    });
    return window.__pdfJsLoading;
  }

  function isPdf(blob, name){ return /pdf/i.test(blob.type||'') || /\.pdf$/i.test(name||''); }
  function isImage(blob){ return /^image\//i.test(blob.type||''); }

  /* عارض داخل التطبيق: PDF (عبر pdf.js) أو صورة */
  async function openViewer(blob, name){
    const ov = document.createElement('div');
    ov.className = 'pdf-viewer-ov';
    ov.innerHTML = `<div class="pdf-viewer-bar"><button type="button" class="pv-close">✕ إغلاق</button><span class="pv-name"></span><button type="button" class="pv-save">💾 حفظ</button></div><div class="pdf-viewer-body"><div class="pv-msg">⏳ جاري فتح الملف…</div></div>`;
    const nm = ov.querySelector('.pv-name'); nm.textContent = name || ''; nm.setAttribute('dir','auto'); nm.style.unicodeBidi = 'plaintext';
    document.body.appendChild(ov);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    let imgUrl = null;
    const close = ()=>{ ov.remove(); document.body.style.overflow = prev; if(imgUrl) URL.revokeObjectURL(imgUrl); };
    ov.querySelector('.pv-close').addEventListener('click', close);
    ov.querySelector('.pv-save').addEventListener('click', ()=> saveBlob(blob, name));
    const body = ov.querySelector('.pdf-viewer-body');
    try{
      if(isImage(blob)){
        imgUrl = URL.createObjectURL(blob);
        body.innerHTML = '';
        const im = document.createElement('img'); im.src = imgUrl; im.style.cssText = 'max-width:100%;background:#fff;border-radius:6px';
        body.appendChild(im); return;
      }
      const lib = await loadPdfJs();
      const pdf = await lib.getDocument({ data: await blob.arrayBuffer(), disableFontFace: true, useSystemFonts: false }).promise;
      body.innerHTML = '';
      const w = Math.min(body.clientWidth - 16, 900);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for(let p=1; p<=pdf.numPages; p++){
        const page = await pdf.getPage(p);
        const base = page.getViewport({ scale:1 });
        const vp = page.getViewport({ scale: (w / base.width) * dpr });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        c.style.width = (vp.width / dpr) + 'px'; c.style.height = (vp.height / dpr) + 'px';
        body.appendChild(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    }catch(e){
      console.error('تعذّر عرض الملف داخل التطبيق:', e);
      body.innerHTML = '<div class="pv-msg">⚠️ تعذّر عرض الملف هنا (تحقق من الإنترنت).<br>اضغط «💾 حفظ» ثم افتحه من تطبيق الملفات.</div>';
    }
  }

  /* نافذة "اكتمل التحميل" */
  function deliver(blob, name){
    name = name || 'file';
    const old = document.querySelector('.dl-sheet-ov'); if(old) old.remove();
    const canOpen = isPdf(blob, name) || isImage(blob);
    const ov = document.createElement('div');
    ov.className = 'dl-sheet-ov';
    ov.innerHTML = `<div class="dl-sheet" role="dialog" aria-live="polite">
      <div class="dl-ok">✅ اكتمل التحميل</div>
      <div class="dl-file"><span class="dl-fname"></span> <small>(${fmtSize(blob.size)})</small></div>
      <div class="dl-actions">
        ${canOpen ? '<button type="button" class="dl-open">📂 فتح الملف</button>' : ''}
        <button type="button" class="dl-save">💾 حفظ في الهاتف</button>
      </div>
      <div class="dl-note"></div>
      <button type="button" class="dl-close">إغلاق</button>
    </div>`;
    ov.querySelector('.dl-fname').textContent = name;
    document.body.appendChild(ov);
    const close = ()=> ov.remove();
    ov.addEventListener('click', e=>{ if(e.target === ov) close(); });
    ov.querySelector('.dl-close').addEventListener('click', close);
    const o = ov.querySelector('.dl-open'); if(o) o.addEventListener('click', ()=> openViewer(blob, name));
    ov.querySelector('.dl-save').addEventListener('click', ()=>{
      saveBlob(blob, name);
      ov.querySelector('.dl-note').textContent = '💾 بدأ الحفظ — ستجد الملف في إشعارات التنزيل أو مجلد «التنزيلات/Downloads».';
    });
  }

  /* اعتراض أي تحميل عبر <a download> بمحتوى blob:/data: */
  function shouldIntercept(a){
    return !bypass && a && a.hasAttribute && a.hasAttribute('download') && /^(blob:|data:)/i.test(a.href || '');
  }
  function intercept(a){
    const href = a.href, name = a.getAttribute('download') || 'file';
    fetch(href).then(r=> r.blob()).then(b=> deliver(b, name)).catch(err=>{
      console.error('DownloadUX: تعذّر اعتراض التحميل، حفظ مباشر:', err);
      bypass = true; try{ HTMLAnchorElement.prototype.click.call(a); } finally { bypass = false; }
    });
  }
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if(shouldIntercept(this)){ intercept(this); return; }
    return origClick.apply(this, arguments);
  };
  const origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function(ev){
    if(ev && ev.type === 'click' && this instanceof HTMLAnchorElement && shouldIntercept(this)){ intercept(this); return true; }
    return origDispatch.apply(this, arguments);
  };
  document.addEventListener('click', function(e){
    const a = e.target && e.target.closest && e.target.closest('a[download]');
    if(a && shouldIntercept(a)){ e.preventDefault(); intercept(a); }
  }, true);

  window.DownloadUX = { deliver, openViewer, saveBlob, fmtSize };
  /* أسماء قديمة تستعملها أزرار «تحميل الدرس PDF» في app.js */
  window.pdfFmtSize = fmtSize;
  window.pdfSaveBlob = saveBlob;
  window.openPdfViewer = openViewer;
})();

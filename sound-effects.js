/* =========================================================================================
   نظام المؤثرات الصوتية الهادئة للمنصة (Sound Effects)
   -----------------------------------------------------------------------------------------
   يعتمد بالكامل على Web Audio API: كل صوت يُركَّب برمجيًا (نغمات جيبية ناعمة) في اللحظة نفسها،
   دون أي ملفات mp3/base64 خارجية. هذا يضمن:
     • عدم وجود أي تأخير في التحميل أو طلبات شبكة (الصوت يُنتَج فوريًا في المتصفح).
     • حجمًا شبه معدوم يُضاف لحجم التطبيق (ملف واحد صغير، لا وسائط).
     • عمل الصوت حتى بلا اتصال بالإنترنت (يتوافق مع طبيعة PWA لهذه المنصة).
   جميع الأصوات هادئة ومنخفضة الحدة (موجات جيبية sine، مدة قصيرة جدًا، مستوى صوت خفيف) لتناسب
   الطابع الراقي والمهدئ للمنصة، ولا تتكرر بإزعاج لأنها قصيرة جدًا (أقل من ثلث ثانية).
   ========================================================================================= */
window.SoundFX = (function () {
  const STORAGE_KEY = 'sfx_enabled';
  let ctx = null;
  let masterGain = null;

  function isEnabled() {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === '1'; // مُفعَّل افتراضيًا
  }
  function setEnabled(v) {
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (e) {}
  }

  /* إنشاء AudioContext بشكل كسول عند أول تفاعل حقيقي من المستخدم — مطلوب من متصفحات
     الجوال (iOS/Android) التي تمنع تشغيل الصوت قبل أي لمسة من المستخدم */
  function ensureContext() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1; // التحكم الفعلي بالمستوى يتم لكل نغمة على حدة
      masterGain.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  /* نغمة واحدة ناعمة مع صعود/هبوط سلس للصوت (envelope) لتفادي أي "طقطقة" عند البداية/النهاية */
  function scheduleTone(startTime, note) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const peak = note.peak != null ? note.peak : 0.25;
    const dur = note.dur;
    osc.type = note.type || 'sine';
    osc.frequency.setValueAtTime(note.freq, startTime);
    if (note.glideTo) {
      osc.frequency.exponentialRampToValueAtTime(note.glideTo, startTime + dur);
    }
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peak, startTime + Math.min(0.015, dur / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.03);
  }

  function playNotes(notes) {
    if (!isEnabled()) return;
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const now = ctx.currentTime;
    notes.forEach(n => scheduleTone(now + (n.at || 0), n));
  }

  return {
    /* نقرة خفيفة جدًا لأزرار الواجهة والتبويبات العامة */
    click() { playNotes([{ freq: 880, dur: 0.05, peak: 0.18 }]); },

    /* تنقّل بين شاشات التطبيق: نغمة قصيرة صاعدة خفيفة أشبه بـ"سواش" ناعم */
    navigate() { playNotes([{ freq: 480, dur: 0.09, peak: 0.16, glideTo: 720 }]); },

    /* إجابة صحيحة / نجاح: نغمتان صاعدتان لطيفتان */
    correct() {
      playNotes([
        { freq: 659.25, at: 0, dur: 0.10, peak: 0.24 },
        { freq: 987.77, at: 0.09, dur: 0.18, peak: 0.24 }
      ]);
    },

    /* إجابة غير صحيحة: نغمة واحدة هادئة هابطة، تنبيه لطيف غير محبط أو مزعج */
    wrong() { playNotes([{ freq: 311.13, dur: 0.18, peak: 0.16, glideTo: 220 }]); },

    /* تسجيل الدخول: ثلاث نغمات ترحيبية دافئة صاعدة */
    login() {
      playNotes([
        { freq: 523.25, at: 0, dur: 0.09, peak: 0.20 },
        { freq: 659.25, at: 0.08, dur: 0.09, peak: 0.20 },
        { freq: 783.99, at: 0.16, dur: 0.18, peak: 0.22 }
      ]);
    },

    /* تسجيل الخروج: نغمتان هابطتان هادئتان */
    logout() {
      playNotes([
        { freq: 659.25, at: 0, dur: 0.09, peak: 0.18 },
        { freq: 493.88, at: 0.08, dur: 0.16, peak: 0.16 }
      ]);
    },

    isEnabled: isEnabled,
    setEnabled: setEnabled,
    toggle() { setEnabled(!isEnabled()); return isEnabled(); },

    /* استدعاء مرة واحدة عند أول لمسة من المستخدم لضمان عمل الصوت على الجوال */
    warmUp() { ensureContext(); }
  };
})();

/* =========================================================================================
   ربط المؤثرات الصوتية بالواجهة — آلية عامة (event delegation) تعمل على كل الأزرار والتبويبات
   وبطاقات التنقّل الحالية والمستقبلية دون الحاجة لتعديل كل مكان في الكود على حدة.
   ========================================================================================= */
document.addEventListener('DOMContentLoaded', function () {
  /* تفعيل AudioContext عند أول تفاعل فعلي (نقرة أو لمسة) — متطلب من المتصفحات الحديثة */
  document.addEventListener('pointerdown', function warmupOnce() {
    SoundFX.warmUp();
    document.removeEventListener('pointerdown', warmupOnce);
  }, { once: true, passive: true });

  /* نقرة عامة على الأزرار/التبويبات/البطاقات، باستثناء العناصر التي تُصدر صوتها الخاص
     من مكان آخر في الكود (تنقّل الشاشات، إجابات الأسئلة، الدخول/الخروج) لتفادي ازدواج الصوت */
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (!(t instanceof Element)) return;

    // عناصر التنقّل بين الشاشات تُصدر صوت navigate() مباشرة من Screens.show
    if (t.closest('[data-nav]')) return;

    // عناصر لها صوت مخصص خاص بها مُدرج مباشرة في منطقها (نجاح/خطأ/دخول/خروج)
    if (t.closest('.mcq-btn, #unitCheckBtn, #extractRows .extract-row-remove, #loginSubmitBtn, #studentLogoutBtn, #adminLogoutBtn')) return;

    // قائمة العناصر التفاعلية المعروفة صراحةً في المنصة
    const known = t.closest(
      'button, a, [role="button"], .lesson-row, .story-list-item, .exam-tab, .situ-tab, ' +
      '.irab-launch, .home-card, .home-card-wide, .notification-bell'
    );
    if (known) { SoundFX.click(); return; }

    // كشف احتياطي عام: أي عنصر يبدو "قابلًا للنقر" (مؤشر الفأرة pointer)، ليشمل عناصر
    // مستقبلية في الواجهة دون الحاجة لتعديل هذا الملف عند كل إضافة جديدة
    const cs = window.getComputedStyle(t);
    if (cs.cursor === 'pointer') SoundFX.click();
  }, true);
});

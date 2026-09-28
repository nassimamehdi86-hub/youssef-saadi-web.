/* =========================================================================================
   شريط الأمثال والحكم — Wisdom Quotes Banner
   يعرض أمثالاً وعبراً مشجعة للتلاميذ بتصميم ذهبي أنيق، مع حركة انتقال سلسة (Fade + Slide)
   ========================================================================================= */

const WisdomQuotes = {
  quotes: [
    "العلم نور يضيء الطريق نحو المستقبل المشرق",
    "من جدّ وجد، ومن سار على الطريق وصل إلى الهدف",
    "اطلب العلم من المهد إلى اللحد",
    "العقل السليم في الجسم السليم يحتاج إلى علم صليب",
    "الاجتهاد والمثابرة مفاتيح النجاح والتفوق",
    "كل صعب يسير إذا صبرت عليه",
    "لا تستح من طلب العلم فإن العلم ضياع النفس",
    "من سعى إلى تحسين نفسه فقد وجد الطريق الصحيح",
    "التعليم هو أفضل استثمار في حياتك",
    "المثابرة والعزيمة تحقق المستحيل",
    "اليوم الذي لا تتعلم فيه شيئاً جديداً يوم ضائع",
    "لكل مجتهد نصيب من التقدم والنجاح",
    "الخطأ خطوة نحو التعلم الصحيح",
    "تذكر دائماً: أنت قادر على تحقيق أحلامك",
    "الوقت ذهب، فلا تضيعه بالتأخير والكسل",
    "المعلم الفاضل هو الذي يبني في أذهان طلابه معانياً سليمة",
    "اللغة العربية لسان قومك وهويتك",
    "حين تحب ما تتعلمه تصبح الدراسة متعة وليست عبء",
    "أنت أقوى مما تظن، وقدراتك أعظم من أحلامك",
    "كل خطوة صغيرة في الدراسة تقربك من حلمك الكبير"
  ],

  currentIndex: 0,
  quoteInterval: null,
  displayElement: null,
  textEl: null,
  indicatorEl: null,
  /* مدة حركة الـ Fade Out بالميلي ثانية — يجب أن تطابق مدة الانتقال (transition) في CSS
     لخاصية .wisdom-text.wisdom-fade كي يتم تبديل النص بعد اكتمال الاختفاء تماماً لا قبله */
  FADE_MS: 380,

  /* تهيئة شريط الأمثال — تُبنى عناصر DOM مرة واحدة فقط، وبعدها يُحدَّث نصها فقط
     (بدل إعادة كتابة innerHTML بالكامل في كل مرة) كي تعمل حركة الانتقال بسلاسة */
  init(containerElement) {
    if (!containerElement) return;
    this.displayElement = containerElement;
    this.currentIndex = 0;
    this.stop();

    containerElement.innerHTML = `
      <div class="wisdom-banner">
        <div class="wisdom-content">
          <span class="wisdom-icon">✨</span>
          <div class="wisdom-text-wrap">
            <div class="wisdom-text" id="wisdomTextEl"></div>
          </div>
          <span class="wisdom-indicator" id="wisdomIndicatorEl"></span>
        </div>
      </div>
    `;

    this.textEl = containerElement.querySelector('#wisdomTextEl');
    this.indicatorEl = containerElement.querySelector('#wisdomIndicatorEl');
    this.renderQuote(false);

    /* تغيير الأمثال كل 6 ثوانٍ */
    this.quoteInterval = setInterval(() => this.nextQuote(), 6000);
  },

  /* عرض المثل الحالي — animate=true يشغّل حركة اختفاء/ظهور سلسة قبل تبديل النص */
  renderQuote(animate) {
    if (!this.textEl || !this.indicatorEl) return;
    const quote = this.quotes[this.currentIndex];
    const indicator = `${this.currentIndex + 1}/${this.quotes.length}`;

    if (!animate) {
      this.textEl.textContent = quote;
      this.indicatorEl.textContent = indicator;
      return;
    }

    this.textEl.classList.add('wisdom-fade');
    setTimeout(() => {
      this.textEl.textContent = quote;
      this.indicatorEl.textContent = indicator;
      this.textEl.classList.remove('wisdom-fade');
    }, this.FADE_MS);
  },

  /* الانتقال إلى الأمثال التالي */
  nextQuote() {
    this.currentIndex = (this.currentIndex + 1) % this.quotes.length;
    this.renderQuote(true);
  },

  /* الانتقال إلى الأمثال السابق */
  prevQuote() {
    this.currentIndex = (this.currentIndex - 1 + this.quotes.length) % this.quotes.length;
    this.renderQuote(true);
  },

  /* التوقف عن تحديث الأمثال */
  stop() {
    if (this.quoteInterval) {
      clearInterval(this.quoteInterval);
      this.quoteInterval = null;
    }
  }
};

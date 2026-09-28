/* =========================================================================================
   إضافات app.js — التحديثات المتقدمة
   - إزالة القفل الفوري عند فتح الدرس من الأستاذ
   - شريط الأمثال والحكم في واجهة التلاميذ
   - نظام الإشعارات المتكامل
   - إدارة التلاميذ (الحذف، الرسائل الجماعية)
   ========================================================================================= */

/* ===== إظهار تنبيه مرئي عند فشل القراءة/الكتابة في Firestore بسبب قواعد الأمان (Rules) =====
   هذا التنبيه يظهر مرة واحدة فقط لكل نوع مشكلة (بدل تكراره في كل مرة يفشل فيها onSnapshot)
   لأن السبب الشائع لهذا الخطأ هو أن قواعد Firestore لا تسمح بالقراءة العامة (بدون Firebase Auth)
   لمجموعات مثل notifications أو state، بينما هذا التطبيق يعتمد نظام PIN وليس Firebase Auth حقيقي. */
const _fbNoticeShown = new Set();
function showFbPermissionNotice(context){
  if (_fbNoticeShown.has(context)) return;
  _fbNoticeShown.add(context);
  const el = document.getElementById('fbNotice');
  if (!el) return;
  const labels = {
    notifications: 'الإشعارات وجرس التنبيهات',
    locks: 'حالة فتح/إغلاق الدروس',
    zoomLinks: 'روابط حصص الزوم للأفواج',
    examLinks: 'روابط الفروض والاختبارات'
  };
  el.innerHTML += `<div class="note" style="margin:10px 0;border-color:#c0392b">
    <b>⚠️ تعذّر الاتصال بقاعدة البيانات لتحديث: ${labels[context] || context}.</b><br>
    السبب الأكثر شيوعًا: قواعد الأمان (Rules) في Firebase Console لا تسمح بالقراءة/الكتابة العامة
    لهذه المجموعة (لأن التطبيق لا يستخدم Firebase Authentication، بل نظام رقم سري PIN).
    افتح Firebase Console ← Firestore Database ← Rules، وتأكد من وجود:
    <pre style="white-space:pre-wrap;font-size:11px;background:#fff;padding:8px;border-radius:8px;margin-top:6px">match /notifications/{id} { allow read, write: if true; }
match /state/{id} { allow read, write: if true; }</pre>
    ثم اضغط "نشر" (Publish).
  </div>`;
}

/* ===== تحديث نظام القفل: فتح فوري مع تنبيه الجرس ===== */
const LocksEnhanced = {
  /* تحديث setLesson لإضافة إشعار عند فتح الدرس */
  async setLessonWithNotification(id, open, lessonTitle) {
    if (!fbReady) return;
    
    /* فتح/إغلاق الدرس — نُحدّث الحالة محليًا فقط بعد نجاح الكتابة الفعلية في Firestore،
       كي لا تظهر لوحة التحكم الدرس "مفتوحًا" بينما فشلت الكتابة فعليًا بصمت (permission-denied) */
    const previousValue = Locks.data.lessons ? Locks.data.lessons[id] : undefined;
    const previousOpenedAt = Locks.data.openedAt ? Locks.data.openedAt[id] : undefined;
    Locks.data.lessons = Locks.data.lessons || {};
    Locks.data.lessons[id] = !!open;
    /* وقت الفتح: يجعل آخر درس مفتوح يتصدر قائمة الدروس */
    if (open) { Locks.data.openedAt = Locks.data.openedAt || {}; Locks.data.openedAt[id] = Date.now(); }
    try {
      await db.collection('state').doc('locks').set(Locks.data, { merge: true });
    } catch (error) {
      /* تراجع عن التحديث المحلي لأن الكتابة الحقيقية فشلت */
      Locks.data.lessons[id] = previousValue;
      if (Locks.data.openedAt) Locks.data.openedAt[id] = previousOpenedAt;
      console.error('فشل فتح/إغلاق الدرس (تحقق من قواعد Firestore لمجموعة state):', error);
      if (typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
      alert('تعذّر حفظ حالة الدرس في قاعدة البيانات. راجع التنبيه الظاهر أعلى الصفحة لمعرفة السبب.');
      return false;
    }

    /* إذا تم الفتح، أرسل إشعار وتنبيه */
    if (open && NotificationsSystem) {
      const sent = await NotificationsSystem.addNewContentAlert('lesson', lessonTitle, 'متاح الآن للتلاميذ');
      if (!sent) {
        alert('تم فتح الدرس بنجاح، لكن تعذّر إرسال إشعار به للتلاميذ. راجع التنبيه أعلى الصفحة.');
      }
    }
    return true;
  },

  /* تحديث setTrimester لإضافة إشعار عند فتح فصل الفروض والاختبارات */
  async setTrimesterWithNotification(t, open, trimesterLabel) {
    if (!fbReady) return;

    const previousValue = Locks.data.trimesters ? Locks.data.trimesters[t] : undefined;
    Locks.data.trimesters = Locks.data.trimesters || {};
    Locks.data.trimesters[t] = !!open;
    try {
      await db.collection('state').doc('locks').set(Locks.data, { merge: true });
    } catch (error) {
      /* تراجع عن التحديث المحلي لأن الكتابة الحقيقية فشلت */
      Locks.data.trimesters[t] = previousValue;
      console.error('فشل فتح/إغلاق فصل الفروض والاختبارات (تحقق من قواعد Firestore لمجموعة state):', error);
      if (typeof showFbPermissionNotice === 'function') showFbPermissionNotice('locks');
      alert('تعذّر حفظ حالة الفصل في قاعدة البيانات. راجع التنبيه الظاهر أعلى الصفحة لمعرفة السبب.');
      return false;
    }

    /* إذا تم الفتح، أرسل إشعارًا فوريًا بأن فروضًا/اختبارات جديدة صارت متاحة */
    if (open && NotificationsSystem) {
      const sent = await NotificationsSystem.addNewContentAlert(
        'exam',
        trimesterLabel,
        'الفروض والاختبارات صارت متاحة الآن'
      );
      if (!sent) {
        alert('تم فتح الفصل بنجاح، لكن تعذّر إرسال إشعار به للتلاميذ. راجع التنبيه أعلى الصفحة.');
      }
    }
    return true;
  }
};

/* ===== تجديد واجهة الدروس عند فتحها (Live Update) ===== */
function setupLessonLiveUpdates() {
  if (!fbReady || !db) return;
  
  /* الاستماع لتغييرات الأقفال */
  Locks.listen(() => {
    /* إعادة تحديث قائمة الدروس إذا كان الطالب يشاهدها الآن */
    const lessonsScreenEl = document.getElementById('screen-lessons');
    if (lessonsScreenEl && lessonsScreenEl.style.display !== 'none' && typeof renderLessonsScreen === 'function') {
      renderLessonsScreen();
    }
  });
}

/* ===== تهيئة شريط الأمثال والحكم في الصفحة الرئيسية ===== */
function initWisdomBanner() {
  const wisdomContainer = document.getElementById('wisdomBannerContainer');
  if (wisdomContainer && typeof WisdomQuotes !== 'undefined') {
    WisdomQuotes.init(wisdomContainer);
  }
}

/* ===== تهيئة نظام الإشعارات والجرس ===== */
function initNotificationsSystem() {
  const bellIcon = document.getElementById('notificationBell');
  const notificationsPanel = document.getElementById('notificationsPanel');
  const notificationsContent = document.getElementById('notificationsContent');
  
  if (bellIcon && notificationsPanel) {
    if (typeof NotificationsSystem !== 'undefined') {
      /* يجب تمرير الحاوية الداخلية (notificationsContent) وليس اللوحة كاملة (notificationsPanel)،
         وإلا فإن renderNotifications() سيستبدل عنوان اللوحة وزر إغلاقها بقائمة الإشعارات نفسها */
      NotificationsSystem.init(bellIcon, notificationsContent || notificationsPanel);
      
      /* إضافة حدث الضغط على الجرس */
      bellIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        notificationsPanel.classList.toggle('show');
      });
      
      /* إغلاق لوحة الإشعارات عند الضغط في أي مكان آخر */
      document.addEventListener('click', () => {
        notificationsPanel.classList.remove('show');
      });
    }
  }
}

/* ===== تطبيق إدارة التلاميذ في لوحة التحكم ===== */
async function renderStudentManagementPanel() {
  const wrap = document.getElementById('adminWrap');

  /* نُلحق قسم "إدارة التلاميذ" كعنصر DOM مستقل قابل للحذف/الإعادة بمفرده، بدل إعادة
     كتابة wrap.innerHTML بالكامل (وهو ما كان يدمّر كل عناصر اللوحة الموجودة مسبقًا — بما
     فيها أزرار فتح/إغلاق الدروس وقبول/رفض التلاميذ — ويفقدها مستمعي النقر المرتبطة بها). */
  const existingSection = document.getElementById('studentManagementSection');
  if (existingSection) existingSection.remove();

  const section = document.createElement('div');
  section.id = 'studentManagementSection';

  const studentManageBody = `
    <div class="student-management-panel">
      <div class="search-bar">
        <input type="text" id="studentSearchManage" placeholder="🔎 ابحث عن تلميذ..." 
          style="width:100%;padding:10px 14px;border-radius:11px;border:1.4px solid #A97F2A;font-family:'Cairo';font-size:13px;margin-bottom:12px;background:#FFFDF7;color:#22352B">
      </div>

      <div class="bulk-actions" style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <button id="selectAllStudentsBtn" class="al-key" style="flex:1;min-width:120px">☑️ تحديد الكل</button>
        <button id="deselectAllStudentsBtn" class="al-key" style="flex:1;min-width:120px">☐ إلغاء التحديد</button>
        <button id="deleteSelectedBtn" class="al-key" style="flex:1;min-width:140px;background:#c84;color:#fff">🗑️ حذف المحددين</button>
        <button id="exportStudentsBtn" class="al-key" style="flex:1;min-width:140px">📥 تصدير CSV</button>
        <button id="backfillAveragesBtn" class="al-key" style="flex:1;min-width:220px">🔄 تحديث معدّلات التلاميذ القدامى (مرة واحدة)</button>
      </div>

      <div id="selectedCountDisplay" style="font-size:12px;font-weight:700;color:#A97F2A;margin-bottom:10px">المحددون: 0</div>

      <div class="lesson-list" id="studentsListManage"></div>
    </div>`;

  const notifyBody = `
    <div class="notification-form">
      <input type="text" id="notificationTitle" placeholder="عنوان الإشعار (مثل: درس جديد)" 
        style="width:100%;padding:10px 14px;border-radius:11px;border:1.4px solid #A97F2A;font-family:'Cairo';font-size:13px;margin-bottom:10px;background:#FFFDF7;color:#22352B">
      <textarea id="notificationMessage" placeholder="نص الإشعار..." 
        style="width:100%;padding:10px 14px;border-radius:11px;border:1.4px solid #A97F2A;font-family:'Cairo';font-size:13px;margin-bottom:10px;background:#FFFDF7;color:#22352B;resize:vertical;height:80px"></textarea>
      <button id="sendNotificationBtn" class="install-btn" style="width:100%;justify-content:center">📢 إرسال الإشعار</button>
    </div>`;

  section.innerHTML =
    adminAccordionHTML('studentManage', `🧑‍🎓 إدارة وحذف التلاميذ`, studentManageBody) +
    adminAccordionHTML('sendNotif', `📢 إرسال إشعار للتلاميذ`, notifyBody);

  wrap.appendChild(section);
  wireAdminAccordions(section);

  /* تحميل التلاميذ والتعامل مع البحث */
  const students = await StudentManagement.loadStudents();
  const searchInput = document.getElementById('studentSearchManage');
  const listContainer = document.getElementById('studentsListManage');
  const selectedCountDisplay = document.getElementById('selectedCountDisplay');

  const renderStudentsList = (filteredStudents = students) => {
    listContainer.innerHTML = filteredStudents.map((student, index) => `
      <div class="lesson-row student-item" data-student-id="${student.id}" data-student-name="${student.fullName}">
        <div class="lr-num">
          <input type="checkbox" class="student-checkbox" data-student-id="${student.id}" 
            ${StudentManagement.selectedStudents.has(student.id) ? 'checked' : ''}>
        </div>
        <div class="lr-text">
          <div class="lr-title">${student.fullName}</div>
          <div style="font-size:11px;color:#5B6E62">${student.status === 'approved' ? '✅ مقبول' : '⏳ في الانتظار'}</div>
        </div>
        <button class="al-key" style="width:auto;padding:6px 14px" data-delete-student="${student.id}">🗑️ حذف</button>
      </div>
    `).join('');

    /* تعليق أحداث الحذف */
    listContainer.querySelectorAll('[data-delete-student]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-student');
        if (confirm('هل أنت متأكد من حذف هذا التلميذ؟')) {
          if (await StudentManagement.deleteStudent(id)) {
            alert('تم حذف التلميذ بنجاح');
            renderStudentManagementPanel();
          } else {
            alert(describeStudentDeleteError());
          }
        }
      });
    });

    /* تعليق أحداث الاختيار */
    listContainer.querySelectorAll('.student-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        const id = checkbox.getAttribute('data-student-id');
        StudentManagement.toggleStudentSelection(id);
        updateSelectedCount();
        updateCheckboxes();
      });
    });
  };

  const updateSelectedCount = () => {
    selectedCountDisplay.textContent = `المحددون: ${StudentManagement.getSelectedCount()}`;
  };

  const updateCheckboxes = () => {
    listContainer.querySelectorAll('.student-checkbox').forEach(checkbox => {
      const id = checkbox.getAttribute('data-student-id');
      checkbox.checked = StudentManagement.selectedStudents.has(id);
    });
  };

  /* البحث عن التلاميذ */
  searchInput.addEventListener('input', (e) => {
    const filtered = StudentManagement.searchStudents(e.target.value);
    renderStudentsList(filtered);
  });

  /* تحديد الكل */
  document.getElementById('selectAllStudentsBtn').addEventListener('click', () => {
    StudentManagement.selectAll();
    updateSelectedCount();
    updateCheckboxes();
  });

  /* إلغاء التحديد */
  document.getElementById('deselectAllStudentsBtn').addEventListener('click', () => {
    StudentManagement.deselectAll();
    updateSelectedCount();
    updateCheckboxes();
  });

  /* حذف المحددين */
  document.getElementById('deleteSelectedBtn').addEventListener('click', async () => {
    const count = StudentManagement.getSelectedCount();
    if (count === 0) {
      alert('لم تحدد أي تلاميذ');
      return;
    }
    if (confirm(`هل أنت متأكد من حذف ${count} تلميذ(ة)؟ هذا الإجراء غير قابل للعكس!`)) {
      const ids = Array.from(StudentManagement.selectedStudents);
      if (await StudentManagement.deleteMultipleStudents(ids)) {
        alert(`تم حذف ${count} تلميذ(ة) بنجاح`);
        renderStudentManagementPanel();
      } else {
        alert(describeStudentDeleteError());
      }
    }
  });

  /* تصدير CSV */
  document.getElementById('exportStudentsBtn').addEventListener('click', () => {
    StudentManagement.exportToCSV();
  });

  /* تحديث معدّلات التلاميذ القدامى — عملية تُشغَّل يدويًا مرة واحدة فقط */
  document.getElementById('backfillAveragesBtn').addEventListener('click', async () => {
    const confirmed = confirm(
      'هذه العملية تُقرأ نتائج كل التلاميذ عبر كل الدروس مرة واحدة (تكلفة قراءات كبيرة نسبيًا) ' +
      'لتعبئة معدّل من أنجز تمارين قبل هذا التحديث. شغّلها مرة واحدة فقط بعد نشر التحديث ' +
      '(يُفضَّل بعد تصفير سقف Firestore اليومي)، ولن تحتاج تكرارها بعد ذلك أبدًا.\n\nهل تريد المتابعة؟'
    );
    if (!confirmed) return;
    const btn = document.getElementById('backfillAveragesBtn');
    btn.disabled = true;
    btn.textContent = '⏳ جارٍ التحديث...';
    try {
      const result = await StudentManagement.backfillAverages();
      if (result.ok) {
        alert(`تم تحديث معدّلات ${result.studentsUpdated} تلميذًا بنجاح.`);
        renderStudentManagementPanel();
      } else {
        alert('تعذّر إتمام العملية. تحقق من اتصال الإنترنت وحاول مجددًا.');
        btn.disabled = false;
        btn.textContent = '🔄 تحديث معدّلات التلاميذ القدامى (مرة واحدة)';
      }
    } catch (e) {
      alert('حدث خطأ أثناء التحديث.');
      btn.disabled = false;
      btn.textContent = '🔄 تحديث معدّلات التلاميذ القدامى (مرة واحدة)';
    }
  });

  /* إرسال الإشعار */
  document.getElementById('sendNotificationBtn').addEventListener('click', async () => {
    const title = document.getElementById('notificationTitle').value.trim();
    const message = document.getElementById('notificationMessage').value.trim();

    if (!title || !message) {
      alert('الرجاء ملء عنوان الإشعار والرسالة');
      return;
    }

    try {
      const ok = await NotificationsSystem.sendNotification(title, message, '📢');
      /* sendNotification تُرجع false عند فشل الكتابة (لا ترمي استثناءً)، لذا يجب التحقق
         من القيمة المُعادة صراحةً، وإلا ستظهر رسالة "نجاح" حتى لو رفضت Firestore الكتابة */
      if (ok) {
        alert('تم إرسال الإشعار بنجاح لجميع التلاميذ');
        document.getElementById('notificationTitle').value = '';
        document.getElementById('notificationMessage').value = '';
      } else {
        if (typeof showFbPermissionNotice === 'function') showFbPermissionNotice('notifications');
        alert('تعذّر إرسال الإشعار. راجع التنبيه الظاهر أعلى الصفحة لمعرفة السبب (على الأرجح قواعد Firestore).');
      }
    } catch (e) {
      alert('حدث خطأ في إرسال الإشعار');
    }
  });

  /* عرض القائمة الأولية */
  renderStudentsList();
  updateSelectedCount();
}

/* ===== ترجمة خطأ حذف التلميذ (المحفوظ في StudentManagement.lastError) إلى رسالة مفهومة ===== */
function describeStudentDeleteError() {
  const err = StudentManagement.lastError;
  const code = err && err.code;
  const message = err && err.message;

  if (code === 'permission-denied' || /permission/i.test(message || '')) {
    return 'تعذّر الحذف بسبب صلاحيات قاعدة البيانات (Firestore Rules):\n' +
      'يجب إضافة السطر  allow delete: if true;  داخل match /students/{id} من تبويب Rules في Firebase Console، ثم الضغط على "نشر" (Publish). راجع قسم قواعد الأمان في ملف README.md.';
  }

  /* نعرض دائمًا كل تفاصيل الخطأ الفعلية المتوفرة (الرمز code والنص message) بدل رسالة عامة
     بلا فائدة، لأن الرسالة العامة وحدها لا تكفي لتشخيص المشكلة لاحقًا */
  let details = '';
  if (code) details += `\nرمز الخطأ (code): ${code}`;
  if (message) details += `\nتفاصيل: ${message}`;
  if (!code && !message) details = '\n(لم يتمكن التطبيق من التقاط تفاصيل تقنية للخطأ — افتح "أدوات المطوّر" في المتصفح وتحقق من تبويب Console لمزيد من المعلومات، أو التقط صورة له)';

  return 'حدث خطأ في حذف التلميذ' + details;
}

/* ===== دالة محسّنة لفتح الدرس مع إزالة القفل الفوري ===== */
async function enhancedLessonOpen(lessonId, lessonTitle) {
  if (!Admin.authed) return;
  
  /* فتح الدرس فوراً */
  await LocksEnhanced.setLessonWithNotification(lessonId, true, lessonTitle);
  
  /* إعادة تحديث الواجهة للتلاميذ */
  if (typeof renderLessonsScreen === 'function') {
    renderLessonsScreen();
  }
}

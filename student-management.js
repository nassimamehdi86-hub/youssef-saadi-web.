/* =========================================================================================
   إدارة التلاميذ (Student Management System)
   - حذف التلاميذ بشكل فردي أو جماعي
   - تحديث بيانات التلاميذ
   - إدارة الصلاحيات
   ========================================================================================= */

const StudentManagement = {
  selectedStudents: new Set(),
  allStudents: [],

  /* ⚠️ عملية تُشغَّل يدويًا مرة واحدة فقط (وليست تلقائية) — لتعبئة معدّل التلاميذ الذين
     أنجزوا تمارين قبل اعتماد الحقلين التراكميين (completedExercisesCount و totalScoreSum).
     تكلفتها القرائية تساوي تقريبًا: عدد التلاميذ × عدد الدروس — لذا يُفضَّل تشغيلها مرة
     واحدة فقط بعد نشر هذا التحديث (يُستحسن بعد تصفير السقف اليومي)، ولن تحتاجها بعدها
     إطلاقًا لأن كل تمرين جديد يُحدِّث الحقلين تلقائيًا ولحظيًا من الآن فصاعدًا. */
  async backfillAverages(){
    if(!fbReady) return { ok:false, reason:'offline' };
    const lessons = (window.LESSONS || []).filter(l=>l.locked!=='pending');
    const byStudent = new Map(); // studentId -> {total, count}
    for(const l of lessons){
      try{
        const snap = await db.collection('submissions').doc(l.id).collection('students').get();
        snap.forEach(doc=>{
          const data = doc.data();
          if(data.completed === false) return;
          if(typeof data.percent !== 'number') return;
          const id = doc.id;
          const entry = byStudent.get(id) || { total:0, count:0 };
          entry.total += data.percent;
          entry.count += 1;
          byStudent.set(id, entry);
        });
      }catch(e){ /* تجاهل درسًا تعذّرت قراءته ومتابعة الباقي */ }
    }
    const ids = Array.from(byStudent.keys());
    const chunkSize = 400; /* أقل من حد 500 عملية لكل batch في Firestore */
    for(let i=0; i<ids.length; i+=chunkSize){
      const batch = db.batch();
      ids.slice(i, i+chunkSize).forEach(id=>{
        const e = byStudent.get(id);
        batch.update(db.collection('students').doc(id), {
          completedExercisesCount: e.count,
          totalScoreSum: Math.round(e.total*100)/100
        });
      });
      await batch.commit();
    }
    return { ok:true, studentsUpdated: ids.length };
  },

  /* تحميل قائمة التلاميذ المقبولين */
  async loadStudents() {
    if (!fbReady || !db) {
      console.warn('Firebase غير متاح');
      return [];
    }

    try {
      const snapshot = await db.collection('students')
        .where('status', '==', 'approved')
        .get();
      
      this.allStudents = [];
      snapshot.forEach(doc => {
        this.allStudents.push({
          id: doc.id,
          ...doc.data()
        });
      });

      /* المستوى الحقيقي لكل تلميذ يُقرأ مباشرة من الحقلين التراكميين المحفوظين أصلًا في
         مستنده (completedExercisesCount و totalScoreSum، يُحدَّثان لحظيًا في Submissions.submit
         عند كل تمرين جديد) — بلا أي قراءة إضافية من Firestore لكل تلميذ، بعد أن كانت هذه
         الخطوة تعيد قراءة نتائج كل الدروس لكل تلميذ من جديد في كل مرة (تكلفة كانت تُقاس
         بعدد التلاميذ × عدد الدروس). realAverage تبقى null إن لم يشارك التلميذ في أي تمرين بعد. */
      this.allStudents.forEach(s => {
        const count = (typeof s.completedExercisesCount === 'number') ? s.completedExercisesCount : 0;
        s.realAverage = (count > 0 && typeof s.totalScoreSum === 'number') ? Math.round(s.totalScoreSum / count) : null;
      });

      return this.allStudents;
    } catch (error) {
      console.error('خطأ في تحميل التلاميذ:', error);
      return [];
    }
  },

  /* حذف كل نقاط/نتائج تلميذ واحد من جميع الإحصائيات والترتيبات، قبل حذف حسابه نهائيًا:
     1) نتائج تمارين كل الدروس  → submissions/{lessonId}/students/{studentId}
     2) نتائج الفروض والاختبارات → exams/{examId}/submissions/{studentId}
     3) سجلات حلول تمارين الزوم  → zoomSolutions (حيث studentId == التلميذ)
     بهذا تختفي نقاطه تلقائيًا من: الترتيب الشامل (لوحة الشرف)، ترتيب الفروض والاختبارات،
     وترتيب كل درس على حدة، دون ترك أي أثر لحسابه المحذوف. */
  async deleteStudentPointsEverywhere(studentId) {
    if (!fbReady || !db) return;

    const refsToDelete = [];

    /* 1) نتائج تمارين الدروس — معرف كل مستند فرعي هو نفسه معرف التلميذ */
    (window.LESSONS || []).forEach(lesson => {
      refsToDelete.push(
        db.collection('submissions').doc(lesson.id).collection('students').doc(studentId)
      );
    });

    /* 2) نتائج الفروض والاختبارات */
    try {
      const examsSnap = await db.collection('exams').get();
      examsSnap.forEach(examDoc => {
        refsToDelete.push(
          db.collection('exams').doc(examDoc.id).collection('submissions').doc(studentId)
        );
      });
    } catch (error) {
      console.warn('تعذّر جلب قائمة الفروض والاختبارات أثناء حذف نقاط التلميذ:', error);
    }

    /* 3) سجلات حلول تمارين الزوم */
    try {
      const zoomSnap = await db.collection('zoomSolutions').where('studentId', '==', studentId).get();
      zoomSnap.forEach(doc => refsToDelete.push(doc.ref));
    } catch (error) {
      console.warn('تعذّر جلب سجلات حلول الزوم أثناء حذف نقاط التلميذ:', error);
    }

    /* الحذف على دفعات (حد أقصى 450 عملية لكل دفعة احتياطًا لحد Firestore البالغ 500) */
    const chunkSize = 450;
    for (let i = 0; i < refsToDelete.length; i += chunkSize) {
      const batch = db.batch();
      refsToDelete.slice(i, i + chunkSize).forEach(ref => batch.delete(ref));
      try {
        await batch.commit();
      } catch (error) {
        console.error('خطأ أثناء حذف نقاط التلميذ من الإحصائيات والترتيبات:', error);
      }
    }
  },

  /* إلغاء توثيق تيليجرام الخاص برقم تلميذ محذوف، حتى إن أعاد التسجيل لاحقًا بنفس الرقم
     يُعامل كتلميذ جديد (لا يُقبل تلقائيًا) ويُطالَب بالمرور على بوت تيليجرام من جديد.
     phone هو الرقم كما أُدخل أصلاً (غير المطبَّع)؛ نطبّعه هنا بنفس منطق canonicalPhone
     المستخدم في Student.checkTelegramVerification لضمان مطابقة معرف المستند في
     telegramVerifiedPhones. لا تُرمى أي أخطاء هنا حتى لا يوقف فشل هذه الخطوة عملية
     حذف التلميذ نفسها. */
  async revokeTelegramVerification(phone) {
    if (!fbReady || !db || !phone) return;
    try {
      const canon = (typeof Student !== 'undefined' && Student.canonicalPhone)
        ? Student.canonicalPhone(phone)
        : String(phone).replace(/[^0-9]/g, '').slice(-9);
      if (!canon) return;
      await db.collection('telegramVerifiedPhones').doc(canon).delete();
    } catch (error) {
      console.warn('تعذّر إلغاء توثيق تيليجرام لرقم التلميذ المحذوف:', error);
    }
  },

  /* حذف تلميذ واحد */
  lastError: null,
  async deleteStudent(studentId) {
    this.lastError = null;
    if (!fbReady || !db) {
      alert('لا يمكن حذف التلاميذ بدون اتصال Firebase');
      return false;
    }

    try {
      /* نجلب رقم هاتفه قبل حذف حسابه (من الذاكرة المؤقتة إن وُجد، وإلا من Firestore
         مباشرة) لإلغاء توثيقه في تيليجرام بعد الحذف */
      let phone = (this.allStudents.find(s => s.id === studentId) || {}).phone;
      if (!phone) {
        try {
          const snap = await db.collection('students').doc(studentId).get();
          phone = snap.exists ? snap.data().phone : null;
        } catch (e) { /* تجاهل: سنكمل الحذف حتى لو تعذّر جلب الرقم */ }
      }

      /* حذف كل نقاطه من الإحصائيات والترتيبات أولاً، ثم حذف حسابه نهائيًا */
      await this.deleteStudentPointsEverywhere(studentId);
      await db.collection('students').doc(studentId).delete();
      await this.revokeTelegramVerification(phone);
      this.allStudents = this.allStudents.filter(s => s.id !== studentId);
      return true;
    } catch (error) {
      console.error('خطأ في حذف التلميذ:', error);
      this.lastError = error;
      return false;
    }
  },

  /* حذف عدة تلاميذ في دفعة واحدة */
  async deleteMultipleStudents(studentIds) {
    this.lastError = null;
    if (!fbReady || !db) {
      alert('لا يمكن حذف التلاميذ بدون اتصال Firebase');
      return false;
    }

    try {
      /* نجلب أرقام هواتفهم قبل الحذف (من الذاكرة المؤقتة أولاً، وإلا من Firestore)
         لإلغاء توثيقهم في تيليجرام بعد حذف حساباتهم */
      const phones = await Promise.all(studentIds.map(async (id) => {
        const cached = this.allStudents.find(s => s.id === id);
        if (cached && cached.phone) return cached.phone;
        try {
          const snap = await db.collection('students').doc(id).get();
          return snap.exists ? snap.data().phone : null;
        } catch (e) { return null; }
      }));

      /* حذف نقاط كل تلميذ من الإحصائيات والترتيبات قبل حذف الحسابات — بالتوازي لتسريع
         الحذف الجماعي عند اختيار عدد كبير من التلاميذ */
      await Promise.all(studentIds.map(id => this.deleteStudentPointsEverywhere(id)));

      const batch = db.batch();
      studentIds.forEach(id => {
        const docRef = db.collection('students').doc(id);
        batch.delete(docRef);
      });

      await batch.commit();
      await Promise.all(phones.map(phone => this.revokeTelegramVerification(phone)));
      this.allStudents = this.allStudents.filter(s => !studentIds.includes(s.id));
      this.selectedStudents.clear();
      return true;
    } catch (error) {
      console.error('خطأ في حذف التلاميذ:', error);
      this.lastError = error;
      return false;
    }
  },

  /* تحديد تلميذ */
  toggleStudentSelection(studentId) {
    if (this.selectedStudents.has(studentId)) {
      this.selectedStudents.delete(studentId);
    } else {
      this.selectedStudents.add(studentId);
    }
  },

  /* تحديد الكل */
  selectAll() {
    this.allStudents.forEach(s => this.selectedStudents.add(s.id));
  },

  /* إلغاء تحديد الكل */
  deselectAll() {
    this.selectedStudents.clear();
  },

  /* الحصول على عدد المحددين */
  getSelectedCount() {
    return this.selectedStudents.size;
  },

  /* تحديث بيانات التلميذ */
  async updateStudent(studentId, updates) {
    if (!fbReady || !db) {
      alert('لا يمكن تحديث البيانات بدون اتصال Firebase');
      return false;
    }

    try {
      await db.collection('students').doc(studentId).update(updates);
      const studentIndex = this.allStudents.findIndex(s => s.id === studentId);
      if (studentIndex >= 0) {
        this.allStudents[studentIndex] = {
          ...this.allStudents[studentIndex],
          ...updates
        };
      }
      return true;
    } catch (error) {
      console.error('خطأ في تحديث بيانات التلميذ:', error);
      return false;
    }
  },

  /* الحصول على إحصائيات التلميذ */
  async getStudentStats(studentId) {
    if (!fbReady || !db) return null;

    try {
      const docSnap = await db.collection('students').doc(studentId).get();
      if (docSnap.exists) {
        return docSnap.data();
      }
      return null;
    } catch (error) {
      console.error('خطأ في الحصول على إحصائيات التلميذ:', error);
      return null;
    }
  },

  /* البحث عن التلاميذ بالاسم */
  searchStudents(query) {
    const normalized = normalizeAr(query.toLowerCase());
    return this.allStudents.filter(student => {
      const nameNormalized = normalizeAr(student.fullName.toLowerCase());
      return nameNormalized.includes(normalized);
    });
  },

  /* تصدير قائمة التلاميذ إلى CSV */
  exportToCSV() {
    if (this.allStudents.length === 0) {
      alert('لا توجد بيانات للتصدير');
      return;
    }

    let csv = 'الرقم,الاسم واللقب,حالة الحساب,نسبة التقدم,تاريخ الانضمام\n';
    this.allStudents.forEach((student, index) => {
      const avgDisplay = (student.realAverage === null || student.realAverage === undefined)
        ? 'لم يشارك بعد' : `${student.realAverage}%`;
      const joinDate = student.joinDate ? new Date(student.joinDate).toLocaleDateString('ar-EG') : 'غير محدد';
      csv += `${index + 1},"${student.fullName}",${student.status},${avgDisplay},${joinDate}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `students_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  },

  /* إرسال رسالة جماعية للتلاميذ (عبر الإشعارات) */
  async sendMassMessage(message, studentIds = null) {
    if (!fbReady || !db) {
      alert('لا يمكن إرسال الرسائل بدون اتصال Firebase');
      return false;
    }

    try {
      const ids = studentIds || Array.from(this.selectedStudents);
      if (ids.length === 0) {
        alert('اختر على الأقل تلميذاً واحداً');
        return false;
      }

      /* الإرسال على دفعات (حد أقصى 450 عملية لكل دفعة احتياطًا لحد Firestore البالغ 500)،
         حتى لا تفشل العملية بصمت عند اختيار عدد كبير من التلاميذ دفعة واحدة */
      const chunkSize = 450;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const batch = db.batch();
        ids.slice(i, i + chunkSize).forEach(id => {
          const docRef = db.collection('notifications').doc();
          batch.set(docRef, {
            title: 'رسالة من الأستاذ',
            message,
            icon: '📢',
            timestamp: new Date(),
            isNew: true,
            read: false,
            sentTo: id
          });
        });
        await batch.commit();
      }
      return true;
    } catch (error) {
      console.error('خطأ في إرسال الرسائل الجماعية:', error);
      return false;
    }
  },

  /* الحصول على تقرير نهائي عن التلاميذ */
  async getStudentsReport() {
    if (!fbReady || !db) return null;

    try {
      const students = await this.loadStudents();
      const report = {
        totalStudents: students.length,
        totalApproved: students.filter(s => s.status === 'approved').length,
        averageScore: this.calculateAverageScore(students),
        topPerformers: this.getTopPerformers(students, 5),
        studentsNeedingHelp: this.getStudentsNeedingHelp(students, 5)
      };
      return report;
    } catch (error) {
      console.error('خطأ في إنشاء التقرير:', error);
      return null;
    }
  },

  /* حساب متوسط الدرجات — على أساس التلاميذ الذين شاركوا في تمرين واحد على الأقل فقط،
     حتى لا يُخفَّض المتوسط العام بمن لم يشارك بعد (realAverage = null) */
  calculateAverageScore(students) {
    const participated = students.filter(s => typeof s.realAverage === 'number');
    if (participated.length === 0) return 0;
    const sum = participated.reduce((acc, s) => acc + s.realAverage, 0);
    return Math.round(sum / participated.length);
  },

  /* الحصول على أفضل الطلاب — من بين من شاركوا في التمارين فقط */
  getTopPerformers(students, limit = 5) {
    return students
      .filter(s => typeof s.realAverage === 'number')
      .sort((a, b) => b.realAverage - a.realAverage)
      .slice(0, limit);
  },

  /* الحصول على الطلاب الذين يحتاجون مساعدة — ممن شاركوا وكانت نتيجتهم دون 50% */
  getStudentsNeedingHelp(students, limit = 5) {
    return students
      .filter(s => typeof s.realAverage === 'number' && s.realAverage < 50)
      .sort((a, b) => a.realAverage - b.realAverage)
      .slice(0, limit);
  }
};

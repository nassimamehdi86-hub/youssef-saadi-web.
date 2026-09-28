# منصة الأستاذ يوسف سعيدي — ملاحظات الإعداد

- مشروع Firebase: youssef-saadi-arabe (Firestore فقط).
- firebase-config.js: الرقم السري للأستاذ مضبوط (ADMIN_PIN).
- telegram-config.js: فارغ — املأه عند إنشاء بوت ومجموعة خاصة بهذا الأستاذ.
- lessons-data.js: أضف الدروس (الفيديو + التعريف + الخريطة الذهنية + اختبار الفهم).
- content/exercises/<lessonId>.json: ملف تمارين لكل درس (اختياري).
- irab-data.js: فارغة بانتظار المحتوى.
- الدروس المضافة: عطف النسق (id: atf-nasaq) — تمارينه في content/exercises/atf-nasaq.json. كل درس جديد يكون مقفلًا حتى يفتحه الأستاذ من لوحة التحكم.
- في ملف التمارين يمكن إضافة "alts" (قائمة إجابات بديلة مقبولة) لأي عنصر من نوع fill.

/* =========================================================================================
   نظام الإشعارات والتنبيهات (Notifications & Alerts System)
   - إشعارات فورية من الأستاذ
   - تنبيهات للدروس والتمارين الجديدة مع جرس
   ========================================================================================= */

const NotificationsSystem = {
  notifications: [],
  newContent: { lessons: [], exercises: [] },
  bellElement: null,
  notificationsContainer: null,
  unreadCount: 0,

  /* تهيئة نظام الإشعارات */
  init(bellEl, notifContainer) {
    this.bellElement = bellEl;
    this.notificationsContainer = notifContainer;
    this.loadNotifications();
    this.listenForNewNotifications();
  },

  /* تحميل الإشعارات من Firebase أو LocalStorage */
  loadNotifications() {
    if (auxFbReady()) {
      auxDb().collection('notifications')
        .orderBy('timestamp', 'desc')
        .limit(50)
        .onSnapshot(snapshot => {
          this.notifications = [];
          snapshot.forEach(doc => {
            const data = doc.data();
            this.notifications.push({
              id: doc.id,
              ...data,
              read: data.read || false
            });
          });
          this.updateBellIcon();
          this.renderNotifications();
        }, error => {
          /* غالبًا "permission-denied": قواعد أمان Firestore لا تسمح بقراءة notifications
             بدون تسجيل دخول Firebase Auth (وهذا التطبيق يعتمد نظام PIN وليس Auth حقيقي).
             راجع قسم "قواعد الأمان المطلوبة" في README.md */
          console.error('خطأ في تحميل الإشعارات (تحقق من قواعد Firestore):', error);
          showFbPermissionNotice('notifications');
        });
    } else {
      const stored = lsGet('notifications') || [];
      this.notifications = stored;
      this.updateBellIcon();
    }
  },

  /* الاستماع للإشعارات الجديدة في الوقت الفعلي */
  listenForNewNotifications() {
    if (!auxFbReady()) return;
    /* نتذكر أي إشعار عرضنا شريطه (Banner) بالفعل في هذه الجلسة كي لا يتكرر
       عند كل إعادة تحميل للصفحة أو إعادة اتصال باللحظي (onSnapshot) */
    if (!this._shownBannerIds) this._shownBannerIds = new Set();

    auxDb().collection('notifications')
      .where('isNew', '==', true)
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added' && !this._shownBannerIds.has(change.doc.id)) {
            this._shownBannerIds.add(change.doc.id);
            this.showBannerNotification(change.doc.data());
            this.playNotificationSound();
            /* إطفاء العلم isNew حتى لا يُعاد عرض نفس الإشعار كشريط علوي لاحقًا
               (كل من فتح الصفحة الآن رأى الشريط، والقراءة الفعلية تُدار عبر read/unreadCount) */
            auxDb().collection('notifications').doc(change.doc.id).update({ isNew: false }).catch(() => {});
          }
        });
      }, error => {
        console.error('خطأ في الاستماع للإشعارات الجديدة (تحقق من قواعد Firestore):', error);
        showFbPermissionNotice('notifications');
      });
  },

  /* عرض إشعار كنافذة منبثقة في الأعلى (Banner) */
  showBannerNotification(notifData) {
    const banner = document.createElement('div');
    banner.className = 'notification-banner';
    banner.innerHTML = `
      <div class="notification-banner-content">
        <span class="notif-icon">${notifData.icon || '📢'}</span>
        <div class="notif-message">
          <div class="notif-title">${notifData.title || 'إشعار جديد'}</div>
          <div class="notif-text">${notifData.message || ''}</div>
        </div>
        <button class="notif-close">✕</button>
      </div>
    `;
    document.body.appendChild(banner);

    /* عرض الإشعار لمدة 5 ثوانٍ ثم اختفاؤه */
    banner.classList.add('show');
    const closeBtn = banner.querySelector('.notif-close');
    const closeNotif = () => {
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 300);
    };
    closeBtn.addEventListener('click', closeNotif);
    setTimeout(closeNotif, 5000);
  },

  /* عرض قائمة الإشعارات */
  renderNotifications() {
    if (!this.notificationsContainer) return;
    
    if (this.notifications.length === 0) {
      this.notificationsContainer.innerHTML = `
        <div class="empty-notification">
          <div class="empty-icon">📭</div>
          <div class="empty-text">لا توجد إشعارات جديدة حالياً</div>
        </div>
      `;
      return;
    }

    const html = this.notifications.map(notif => `
      <div class="notification-item ${notif.read ? 'read' : 'unread'}" data-notif-id="${notif.id}">
        <div class="notif-item-icon">${notif.icon || '📢'}</div>
        <div class="notif-item-content">
          <div class="notif-item-title">${notif.title || 'إشعار'}</div>
          <div class="notif-item-message">${notif.message || ''}</div>
          <div class="notif-item-time">${this.formatTime(notif.timestamp)}</div>
        </div>
        <button class="notif-item-delete" data-notif-id="${notif.id}">🗑️</button>
      </div>
    `).join('');

    this.notificationsContainer.innerHTML = html;

    /* تعليق حدث الحذف */
    this.notificationsContainer.querySelectorAll('.notif-item-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const notifId = btn.getAttribute('data-notif-id');
        this.deleteNotification(notifId);
      });
    });

    /* تعليق حدث القراءة */
    this.notificationsContainer.querySelectorAll('.notification-item').forEach(item => {
      item.addEventListener('click', () => {
        const notifId = item.getAttribute('data-notif-id');
        this.markAsRead(notifId);
      });
    });
  },

  /* إرسال إشعار جديد (من الأستاذ) */
  async sendNotification(title, message, icon = '📢') {
    if (!auxFbReady()) {
      alert('لا يمكن إرسال الإشعار بدون اتصال Firebase');
      return false;
    }

    try {
      await auxDb().collection('notifications').add({
        title,
        message,
        icon,
        timestamp: new Date(),
        isNew: true,
        read: false,
        sentBy: 'teacher',
        createdAt: new Date().toISOString()
      });
      return true;
    } catch (error) {
      console.error('خطأ في إرسال الإشعار:', error);
      return false;
    }
  },

  /* إضافة تنبيه عن دروس/تمارين جديدة */
  async addNewContentAlert(contentType, contentName, details = '') {
    const icons = {
      lesson: '📖',
      exercise: '✏️',
      exam: '📝'
    };

    const icon = icons[contentType] || '🆕';
    const title = `${contentType === 'lesson' ? 'درس' : contentType === 'exercise' ? 'تمرين' : 'اختبار'} جديد!`;
    
    return await this.sendNotification(
      title,
      `تم إضافة: ${contentName} ${details ? '— ' + details : ''}`,
      icon
    );
  },

  /* تحديث أيقونة الجرس (إضاءتها بالأحمر عند وجود إشعارات جديدة) */
  updateBellIcon() {
    if (!this.bellElement) return;
    this.unreadCount = this.notifications.filter(n => !n.read).length;
    
    if (this.unreadCount > 0) {
      this.bellElement.classList.add('has-notifications');
      this.bellElement.setAttribute('data-count', this.unreadCount);
    } else {
      this.bellElement.classList.remove('has-notifications');
      this.bellElement.removeAttribute('data-count');
    }
  },

  /* وضع علامة على الإشعار كمقروء */
  async markAsRead(notifId) {
    const notif = this.notifications.find(n => n.id === notifId);
    if (notif) notif.read = true;

    if (auxFbReady()) {
      try {
        await auxDb().collection('notifications').doc(notifId).update({ read: true });
      } catch (e) {
        console.error('خطأ في وضع علامة قراءة:', e);
      }
    }
    this.updateBellIcon();
    this.renderNotifications();
  },

  /* حذف الإشعار */
  async deleteNotification(notifId) {
    this.notifications = this.notifications.filter(n => n.id !== notifId);

    if (auxFbReady()) {
      try {
        await auxDb().collection('notifications').doc(notifId).delete();
      } catch (e) {
        console.error('خطأ في حذف الإشعار:', e);
      }
    } else {
      lsSet('notifications', this.notifications);
    }
    this.updateBellIcon();
    this.renderNotifications();
  },

  /* تنسيق الوقت */
  formatTime(timestamp) {
    if (!timestamp) return 'للتو';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 60) return 'للتو';
    if (diff < 3600) return `قبل ${Math.floor(diff / 60)} دقيقة`;
    if (diff < 86400) return `قبل ${Math.floor(diff / 3600)} ساعة`;
    return `قبل ${Math.floor(diff / 86400)} يوم`;
  },

  /* تشغيل صوت الإشعار */
  playNotificationSound() {
    /* استخدام Web Audio API لتشغيل صوت بسيط */
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.frequency.value = 800;
      oscillator.type = 'sine';
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
      console.log('لا يمكن تشغيل صوت الإشعار');
    }
  }
};

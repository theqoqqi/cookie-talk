/**
 * Cookie Talk — Основная клиентская логика.
 */

// Инициализация сокета
const socket = io();

// Состояние приложения
const state = {
  currentRoomId: null,
  currentRoomName: null,
  isCreator: false,
  username: StorageManager.getUsername(),
  typingTimeout: null,
  activeTypers: new Set(),
  lastMessageSender: null,
  lastMessageTime: null
};

// Список милых псевдонимов для генератора
const FUN_NAMES = [
  'Хрустящее Печенье', 'Шоколадный Кекс', 'Золотистая Вафля', 
  'Медовый Пряник', 'Сладкий Пончик', 'Карамельный Маффин', 
  'Воздушный Зефир', 'Имбирный Коржик', 'Кофейный Блинчик', 'Уютный Чайник'
];

// Палитра цветов для аватаров (сдержанная и современная)
const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#8b5cf6', '#3b82f6', 
  '#10b981', '#14b8a6', '#0ea5e9', '#06b6d4'
];

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getInitials(name) {
  if (!name) return '👤';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин. назад`;
  if (hours < 24) return `${hours} ч. назад`;
  return `${days} дн. назад`;
}

// DOM элементы
const dom = {
  homeView: document.getElementById('home-view'),
  chatView: document.getElementById('chat-view'),
  brandLogo: document.getElementById('brand-logo'),
  soundToggleBtn: document.getElementById('sound-toggle-btn'),
  soundIcon: document.getElementById('sound-icon'),
  
  // Home View
  userNicknameInput: document.getElementById('user-nickname-input'),
  randomNameBtn: document.getElementById('random-name-btn'),
  roomTitleInput: document.getElementById('room-title-input'),
  createRoomBtn: document.getElementById('create-room-btn'),
  savedRoomsList: document.getElementById('saved-rooms-list'),
  savedRoomsCount: document.getElementById('saved-rooms-count'),
  noSavedRooms: document.getElementById('no-saved-rooms'),

  // Chat View
  leaveRoomBtn: document.getElementById('leave-room-btn'),
  currentRoomName: document.getElementById('current-room-name'),
  roleBadge: document.getElementById('role-badge'),
  roomIdTag: document.getElementById('room-id-tag'),
  usersCountText: document.getElementById('users-count-text'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  deleteRoomBtn: document.getElementById('delete-room-btn'),
  messagesContainer: document.getElementById('messages-container'),
  typingIndicator: document.getElementById('typing-indicator'),
  typingText: document.getElementById('typing-text'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  sendMessageBtn: document.getElementById('send-message-btn'),

  // Modals & Toast
  nameModal: document.getElementById('name-modal'),
  nameModalForm: document.getElementById('modal-name-form'),
  nameModalInput: document.getElementById('modal-name-input'),
  modalRoomDesc: document.getElementById('modal-room-desc'),
  deleteModal: document.getElementById('delete-modal'),
  cancelDeleteBtn: document.getElementById('cancel-delete-btn'),
  confirmDeleteBtn: document.getElementById('confirm-delete-btn'),
  toast: document.getElementById('toast'),
  toastIcon: document.getElementById('toast-icon'),
  toastMessage: document.getElementById('toast-message')
};

// Всплывающее уведомление (Toast)
let toastTimer = null;
function showToast(message, icon = '✨') {
  dom.toastIcon.textContent = icon;
  dom.toastMessage.textContent = message;
  dom.toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.classList.add('hidden');
  }, 3000);
}

// Переключение звука
function updateSoundIcon() {
  dom.soundIcon.textContent = Sound.isMuted ? '🔕' : '🔔';
}

dom.soundToggleBtn.addEventListener('click', () => {
  const muted = Sound.toggleMute();
  updateSoundIcon();
  showToast(muted ? 'Звук отключен' : 'Звук включен', muted ? '🔕' : '🔔');
});

// Генерация случайного имени
dom.randomNameBtn.addEventListener('click', () => {
  const name = FUN_NAMES[Math.floor(Math.random() * FUN_NAMES.length)];
  dom.userNicknameInput.value = name;
  state.username = name;
  StorageManager.setUsername(name);
});

// Сохранение имени при изменении
dom.userNicknameInput.addEventListener('input', (e) => {
  state.username = e.target.value.trim();
  StorageManager.setUsername(state.username);
});

// Переключение экранов
function showView(viewName) {
  if (viewName === 'home') {
    dom.homeView.classList.add('active');
    dom.chatView.classList.remove('active');
    document.body.classList.remove('chat-open');
    state.currentRoomId = null;
    renderSavedRooms();
  } else if (viewName === 'chat') {
    dom.homeView.classList.remove('active');
    dom.chatView.classList.add('active');
    document.body.classList.add('chat-open');
    updateViewportHeight();
    setTimeout(scrollToBottom, 60);
  }
}

// Рендеринг списка сохраненных комнат (localStorage)
function renderSavedRooms() {
  const rooms = StorageManager.getRooms();
  dom.savedRoomsCount.textContent = rooms.length;

  if (rooms.length === 0) {
    dom.savedRoomsList.innerHTML = '';
    dom.noSavedRooms.classList.remove('hidden');
    return;
  }

  dom.noSavedRooms.classList.add('hidden');
  dom.savedRoomsList.innerHTML = rooms.map(room => `
    <div class="room-card-item" data-room-id="${room.id}">
      <div class="room-item-info">
        <div class="room-item-header">
          <span class="room-item-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>
          <span class="badge-role ${room.isCreator ? 'badge-creator' : 'badge-member'}">
            ${room.isCreator ? 'Создатель' : 'Участник'}
          </span>
        </div>
        <div class="room-item-time">Визит: ${formatRelativeTime(room.lastVisited)} • <code>${escapeHtml(room.id)}</code></div>
      </div>
      <div class="room-item-actions">
        <button class="btn btn-secondary btn-sm enter-saved-room-btn" data-room-id="${room.id}">
          Войти
        </button>
        <button class="room-delete-local-btn" data-room-id="${room.id}" title="Убрать из сохраненных">
          ✕
        </button>
      </div>
    </div>
  `).join('');

  // Обработчики кнопок входа в комнату
  dom.savedRoomsList.querySelectorAll('.enter-saved-room-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const roomId = btn.getAttribute('data-room-id');
      navigateToRoom(roomId);
    });
  });

  // Обработчики удаления из локального списка
  dom.savedRoomsList.querySelectorAll('.room-delete-local-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const roomId = btn.getAttribute('data-room-id');
      StorageManager.removeRoom(roomId);
      renderSavedRooms();
      showToast('Комната убрана из вашего списка', '🗑️');
    });
  });
}

// Создание новой комнаты
dom.createRoomBtn.addEventListener('click', async () => {
  let name = dom.userNicknameInput.value.trim();
  if (!name) {
    name = FUN_NAMES[Math.floor(Math.random() * FUN_NAMES.length)];
    dom.userNicknameInput.value = name;
  }
  state.username = name;
  StorageManager.setUsername(name);

  const customTitle = dom.roomTitleInput.value.trim();

  dom.createRoomBtn.disabled = true;
  dom.createRoomBtn.textContent = 'Создаем комнату...';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: customTitle })
    });

    const data = await res.json();
    if (data.success) {
      // Сохраняем комнату с правами создателя
      StorageManager.saveRoom({
        id: data.roomId,
        name: data.name,
        isCreator: true,
        creatorKey: data.creatorKey
      });

      dom.roomTitleInput.value = '';
      navigateToRoom(data.roomId);
      showToast('Комната создана!', '🎉');
    } else {
      alert('Ошибка при создании комнаты: ' + (data.error || 'Неизвестная ошибка'));
    }
  } catch (err) {
    console.error('Ошибка запроса:', err);
    alert('Не удалось подключиться к серверу');
  } finally {
    dom.createRoomBtn.disabled = false;
    dom.createRoomBtn.innerHTML = '<span>Создать комнату</span> <span class="btn-arrow">→</span>';
  }
});

// Навигация в комнату
function navigateToRoom(roomId) {
  window.history.pushState(null, '', `/room/${roomId}`);
  joinRoom(roomId);
}

// Возврат на главную
dom.leaveRoomBtn.addEventListener('click', () => {
  window.history.pushState(null, '', '/');
  showView('home');
});

dom.brandLogo.addEventListener('click', () => {
  window.history.pushState(null, '', '/');
  showView('home');
});

window.addEventListener('popstate', () => {
  handleRoute();
});

// Подключение к комнате
function joinRoom(roomId) {
  state.currentRoomId = roomId;

  // Если имя не задано — запрашиваем модальным окном
  if (!state.username) {
    dom.modalRoomDesc.textContent = `Вы подключаетесь к комнате "${roomId}". Введите ваше имя для входа:`;
    dom.nameModal.classList.remove('hidden');
    dom.nameModalInput.focus();
    return;
  }

  const creatorKey = StorageManager.getCreatorKey(roomId);

  // Очищаем предыдущие сообщения
  dom.messagesContainer.innerHTML = `
    <div class="system-message">Подключение к комнате <b>${escapeHtml(roomId)}</b>...</div>
  `;

  socket.emit('join-room', {
    roomId,
    username: state.username,
    creatorKey
  });
}

// Обработка ввода имени в модальном окне
dom.nameModalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = dom.nameModalInput.value.trim();
  if (!name) return;

  state.username = name;
  StorageManager.setUsername(name);
  dom.userNicknameInput.value = name;
  dom.nameModal.classList.add('hidden');

  if (state.currentRoomId) {
    joinRoom(state.currentRoomId);
  }
});

// Socket.IO: Успешный вход в комнату
socket.on('room-joined', (data) => {
  state.currentRoomId = data.roomId;
  state.currentRoomName = data.name;
  state.isCreator = data.isCreator;

  // Сохраняем комнату в localStorage
  StorageManager.saveRoom({
    id: data.roomId,
    name: data.name,
    isCreator: data.isCreator,
    creatorKey: data.isCreator ? StorageManager.getCreatorKey(data.roomId) : null
  });

  // Обновляем заголовок и метаданные
  dom.currentRoomName.textContent = data.name;
  dom.roomIdTag.textContent = `#${data.roomId}`;
  dom.usersCountText.textContent = `${data.users.length} в сети`;

  if (data.isCreator) {
    dom.roleBadge.textContent = 'Создатель';
    dom.roleBadge.className = 'badge-role badge-creator';
    dom.deleteRoomBtn.classList.remove('hidden');
  } else {
    dom.roleBadge.textContent = 'Участник';
    dom.roleBadge.className = 'badge-role badge-member';
    dom.deleteRoomBtn.classList.add('hidden');
  }

  // Рендерим историю сообщений
  dom.messagesContainer.innerHTML = '';
  state.lastMessageSender = null;
  state.lastMessageTime = null;
  
  const createdDate = new Date(data.createdAt).toLocaleDateString();
  appendSystemMessage(`Комната создана: ${createdDate}`);

  if (data.history && data.history.length > 0) {
    data.history.forEach(msg => appendMessage(msg));
  } else {
    appendSystemMessage('История сообщений пока пуста. Начните беседу первым!');
  }

  showView('chat');
  scrollToBottom();
  Sound.playJoin();
});

// Socket.IO: Пользователь вошел
socket.on('user-joined', (data) => {
  dom.usersCountText.textContent = `${data.usersCount} в сети`;
  appendSystemMessage(`<b>${escapeHtml(data.username)}</b> присоединился к чату`);
  Sound.playJoin();
});

// Socket.IO: Пользователь вышел
socket.on('user-left', (data) => {
  dom.usersCountText.textContent = `${data.usersCount} в сети`;
  appendSystemMessage(`<b>${escapeHtml(data.username)}</b> покинул комнату`);
});

// Socket.IO: Новое сообщение
socket.on('new-message', (msg) => {
  appendMessage(msg);
  scrollToBottom();

  if (msg.username === state.username) {
    Sound.playSent();
  } else {
    Sound.playReceived();
  }
});

// Socket.IO: Индикатор набора текста
socket.on('user-typing', ({ username, isTyping }) => {
  if (isTyping) {
    state.activeTypers.add(username);
  } else {
    state.activeTypers.delete(username);
  }

  if (state.activeTypers.size > 0) {
    const typersList = Array.from(state.activeTypers).join(', ');
    dom.typingText.textContent = `${typersList} печатает...`;
    dom.typingIndicator.classList.remove('hidden');
  } else {
    dom.typingIndicator.classList.add('hidden');
  }
});

// Socket.IO: Комната не найдена (404)
socket.on('room-not-found', (data) => {
  alert(`Комната "${data.roomId}" не найдена или была удалена.`);
  StorageManager.removeRoom(data.roomId);
  window.history.pushState(null, '', '/');
  showView('home');
});

// Socket.IO: Комната была удалена создателем
socket.on('room-deleted', (data) => {
  Sound.playAlert();
  alert(data.message || 'Комната была удалена создателем.');
  if (state.currentRoomId) {
    StorageManager.removeRoom(state.currentRoomId);
  }
  window.history.pushState(null, '', '/');
  showView('home');
});

// Socket.IO: Ошибка
socket.on('room-error', (data) => {
  showToast(data.message || 'Произошла ошибка', '⚠️');
});

// Отправка сообщения
dom.messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dom.messageInput.value.trim();
  if (!text || !state.currentRoomId) return;

  socket.emit('send-message', { text });
  dom.messageInput.value = '';

  // Сохраняем фокус на поле ввода (чтобы клавиатура не закрывалась и можно было сразу писать дальше)
  dom.messageInput.focus();

  // Сбрасываем статус "печатает"
  if (state.typingTimeout) clearTimeout(state.typingTimeout);
  socket.emit('typing', { isTyping: false });
});

// Предотвращаем потерю фокуса при нажатии на кнопку отправки (на мобильных сохраняет экранную клавиатуру)
if (dom.sendMessageBtn) {
  dom.sendMessageBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  dom.sendMessageBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (typeof dom.messageForm.requestSubmit === 'function') {
      dom.messageForm.requestSubmit();
    } else {
      dom.messageForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }, { passive: false });
}

// Индикатор набора текста
dom.messageInput.addEventListener('input', () => {
  if (!state.currentRoomId) return;

  socket.emit('typing', { isTyping: true });

  if (state.typingTimeout) clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    socket.emit('typing', { isTyping: false });
  }, 1500);
});

// Копирование ссылки на комнату
dom.copyLinkBtn.addEventListener('click', async () => {
  if (!state.currentRoomId) return;

  const url = `${window.location.origin}/room/${state.currentRoomId}`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    showToast('Ссылка скопирована в буфер обмена!', '📋');
  } catch (err) {
    console.error('Ошибка копирования:', err);
    prompt('Скопируйте ссылку вручную:', url);
  }
});

// Удаление комнаты создателем
dom.deleteRoomBtn.addEventListener('click', () => {
  dom.deleteModal.classList.remove('hidden');
});

dom.cancelDeleteBtn.addEventListener('click', () => {
  dom.deleteModal.classList.add('hidden');
});

dom.confirmDeleteBtn.addEventListener('click', () => {
  dom.deleteModal.classList.add('hidden');
  const creatorKey = StorageManager.getCreatorKey(state.currentRoomId);
  if (!creatorKey) {
    alert('Ключ создателя не найден в вашем браузере');
    return;
  }

  socket.emit('delete-room', {
    roomId: state.currentRoomId,
    creatorKey
  });
});

// Рендеринг сообщения в DOM
function appendMessage(msg) {
  const isSelf = msg.username === state.username;
  const isSameSender = state.lastMessageSender === msg.username;
  // Считаем сообщения подряд, если интервал между ними менее 4 минут
  const isRecent = state.lastMessageTime && (msg.createdAt - state.lastMessageTime < 4 * 60 * 1000);
  const isConsecutive = isSameSender && isRecent;

  state.lastMessageSender = msg.username;
  state.lastMessageTime = msg.createdAt;

  const avatarColor = getAvatarColor(msg.username);
  const initials = getInitials(msg.username);

  const row = document.createElement('div');
  row.className = `message-row ${isSelf ? 'self' : ''} ${isConsecutive ? 'consecutive' : ''}`;

  row.innerHTML = `
    <div class="message-avatar" style="background-color: ${avatarColor}">${initials}</div>
    <div class="message-content">
      ${!isConsecutive ? `
        <div class="message-header">
          <span class="message-sender">${isSelf ? 'Вы' : escapeHtml(msg.username)}</span>
          <span class="message-time">${formatTime(msg.createdAt)}</span>
        </div>
      ` : ''}
      <div class="message-bubble">${linkify(escapeHtml(msg.text))}</div>
    </div>
  `;

  dom.messagesContainer.appendChild(row);
}

function appendSystemMessage(htmlText) {
  state.lastMessageSender = null;
  state.lastMessageTime = null;
  const div = document.createElement('div');
  div.className = 'system-message';
  div.innerHTML = htmlText;
  dom.messagesContainer.appendChild(div);
}

function scrollToBottom() {
  dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
}

// Автоматическая подстройка высоты экрана и прокрутки (iOS Safari / Android Chrome / Экранная клавиатура)
function updateViewportHeight() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${vh}px`);
  if (state.currentRoomId) {
    scrollToBottom();
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateViewportHeight);
  window.visualViewport.addEventListener('scroll', updateViewportHeight);
}
window.addEventListener('resize', updateViewportHeight);
window.addEventListener('orientationchange', () => {
  setTimeout(updateViewportHeight, 150);
});

// Прокрутка при фокусе на поле ввода на мобилках
dom.messageInput.addEventListener('focus', () => {
  setTimeout(() => {
    updateViewportHeight();
    scrollToBottom();
  }, 250);
});

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function linkify(text) {
  const urlPattern = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gim;
  return text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Роутинг по URL при загрузке страницы
function handleRoute() {
  const path = window.location.pathname;
  const searchParams = new URLSearchParams(window.location.search);
  const queryRoom = searchParams.get('room');

  let targetRoomId = null;

  if (path.startsWith('/room/')) {
    targetRoomId = path.replace('/room/', '').split('/')[0].trim();
  } else if (queryRoom) {
    targetRoomId = queryRoom.trim();
  }

  if (targetRoomId) {
    joinRoom(targetRoomId);
  } else {
    showView('home');
  }
}

// Инициализация при запуске
function initApp() {
  updateViewportHeight();
  // Заполняем сохраненное имя пользователя
  if (state.username) {
    dom.userNicknameInput.value = state.username;
    dom.nameModalInput.value = state.username;
  }
  updateSoundIcon();
  handleRoute();
}

initApp();

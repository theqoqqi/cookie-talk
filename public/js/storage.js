/**
 * Модуль для работы с localStorage браузера.
 * Сохраняет:
 * - Имя пользователя
 * - Список посещенных/созданных комнат ("Мои комнаты")
 * - Ключи создателя комнат для возможности удаления
 */
const StorageManager = {
  KEYS: {
    USERNAME: 'cookie_talk_username',
    ROOMS: 'cookie_talk_saved_rooms'
  },

  // Имя пользователя
  getUsername() {
    return localStorage.getItem(this.KEYS.USERNAME) || '';
  },

  setUsername(name) {
    if (name && name.trim()) {
      localStorage.setItem(this.KEYS.USERNAME, name.trim().slice(0, 32));
    }
  },

  // Список сохраненных комнат
  getRooms() {
    try {
      const data = localStorage.getItem(this.KEYS.ROOMS);
      if (!data) return [];
      const rooms = JSON.parse(data);
      // Сортируем по времени последнего визита (сначала свежие)
      return Array.isArray(rooms) ? rooms.sort((a, b) => (b.lastVisited || 0) - (a.lastVisited || 0)) : [];
    } catch (e) {
      console.error('Ошибка чтения комнат из localStorage:', e);
      return [];
    }
  },

  getRoom(roomId) {
    const rooms = this.getRooms();
    return rooms.find(r => r.id === roomId) || null;
  },

  getCreatorKey(roomId) {
    const room = this.getRoom(roomId);
    return room ? room.creatorKey : null;
  },

  getMemberKey(roomId) {
    const room = this.getRoom(roomId);
    return room ? room.memberKey : null;
  },

  // Сохранить или обновить комнату
  saveRoom({ id, name, isCreator = false, creatorKey = null, memberKey = null }) {
    if (!id) return;
    const rooms = this.getRooms();
    const existingIndex = rooms.findIndex(r => r.id === id);

    const updatedRoom = {
      id,
      name: name || (existingIndex !== -1 ? rooms[existingIndex].name : id),
      isCreator: isCreator || (existingIndex !== -1 ? rooms[existingIndex].isCreator : false),
      creatorKey: creatorKey || (existingIndex !== -1 ? rooms[existingIndex].creatorKey : null),
      memberKey: memberKey || (existingIndex !== -1 ? rooms[existingIndex].memberKey : null),
      lastVisited: Date.now()
    };

    if (existingIndex !== -1) {
      rooms[existingIndex] = updatedRoom;
    } else {
      rooms.unshift(updatedRoom);
    }

    localStorage.setItem(this.KEYS.ROOMS, JSON.stringify(rooms));
    return updatedRoom;
  },

  // Удалить комнату из локального списка пользователя
  removeRoom(roomId) {
    const rooms = this.getRooms().filter(r => r.id !== roomId);
    localStorage.setItem(this.KEYS.ROOMS, JSON.stringify(rooms));
  }
};

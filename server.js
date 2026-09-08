const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 7418;

// Инициализация директории данных и базы данных SQLite
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));

// Включаем внешние ключи и создаем таблицы
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    creator_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
`);

// Подготовка SQL-запросов
const stmtGetRoom = db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?');
const stmtGetRoomWithKey = db.prepare('SELECT * FROM rooms WHERE id = ?');
const stmtCreateRoom = db.prepare('INSERT INTO rooms (id, name, creator_key, created_at) VALUES (?, ?, ?, ?)');
const stmtDeleteRoom = db.prepare('DELETE FROM rooms WHERE id = ?');
const stmtDeleteMessages = db.prepare('DELETE FROM messages WHERE id = ?');
const stmtGetMessages = db.prepare('SELECT id, username, text, created_at FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 150');
const stmtInsertMessage = db.prepare('INSERT INTO messages (room_id, username, text, created_at) VALUES (?, ?, ?, ?)');

// Генератор приятных ID комнат
const ADJECTIVES = ['crispy', 'sweet', 'golden', 'cozy', 'warm', 'magic', 'choco', 'sugar', 'honey', 'glazed', 'caramel', 'vanilla'];
const NOUNS = ['cookie', 'biscuit', 'waffle', 'donut', 'muffin', 'cake', 'brownie', 'cupcake', 'marshmallow', 'tea'];

function generateRoomId() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}`;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck эндпоинт для Docker и мониторинга
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// API: Создать комнату
app.post('/api/rooms', (req, res) => {
  try {
    let customName = (req.body && req.body.name) ? req.body.name.trim() : '';
    let roomId = generateRoomId();

    // Проверяем на коллизию (маловероятно, но безопасно)
    while (stmtGetRoom.get(roomId)) {
      roomId = generateRoomId();
    }

    const roomName = customName || `Уютная комната #${roomId.split('-')[2]}`;
    const creatorKey = crypto.randomBytes(24).toString('hex');
    const createdAt = Date.now();

    stmtCreateRoom.run(roomId, roomName, creatorKey, createdAt);

    res.json({
      success: true,
      roomId,
      name: roomName,
      creatorKey,
      createdAt
    });
  } catch (err) {
    console.error('Ошибка создания комнаты:', err);
    res.status(500).json({ success: false, error: 'Не удалось создать комнату' });
  }
});

// API: Проверка существования комнаты и получение данных
app.get('/api/rooms/:id', (req, res) => {
  try {
    const room = stmtGetRoom.get(req.params.id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Комната не найдена' });
    }
    res.json({
      success: true,
      room: {
        id: room.id,
        name: room.name,
        createdAt: room.created_at
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// Роутинг: вход в комнату по ссылке /room/:id перенаправляет на index.html
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хелпер: получение списка активных пользователей в комнате
function getRoomUsers(roomId) {
  const roomSockets = io.sockets.adapter.rooms.get(roomId);
  const users = [];
  if (roomSockets) {
    for (const socketId of roomSockets) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.data && s.data.username) {
        users.push({
          id: socketId,
          username: s.data.username
        });
      }
    }
  }
  return users;
}

// Socket.IO логика
io.on('connection', (socket) => {
  // Подключение к комнате
  socket.on('join-room', ({ roomId, username, creatorKey }) => {
    try {
      if (!roomId || !username) {
        return socket.emit('room-error', { message: 'Укажите ID комнаты и имя пользователя' });
      }

      const room = stmtGetRoomWithKey.get(roomId);
      if (!room) {
        return socket.emit('room-not-found', { roomId });
      }

      const isCreator = Boolean(creatorKey && creatorKey === room.creator_key);

      // Если сокет уже был в другой комнате, выходим
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        const prevRoomId = socket.data.roomId;
        socket.leave(prevRoomId);
        io.to(prevRoomId).emit('user-left', {
          username: socket.data.username,
          usersCount: getRoomUsers(prevRoomId).length
        });
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = username.trim().slice(0, 32);
      socket.data.isCreator = isCreator;

      // Получаем историю сообщений
      const history = stmtGetMessages.all(roomId).map(msg => ({
        id: msg.id,
        username: msg.username,
        text: msg.text,
        createdAt: msg.created_at
      }));

      const currentUsers = getRoomUsers(roomId);

      // Отправляем подключившемуся клиенту подтверждение с историей
      socket.emit('room-joined', {
        roomId: room.id,
        name: room.name,
        createdAt: room.created_at,
        isCreator,
        users: currentUsers,
        history
      });

      // Оповещаем остальных участников о новом собеседнике
      socket.to(roomId).emit('user-joined', {
        username: socket.data.username,
        users: currentUsers,
        usersCount: currentUsers.length
      });
    } catch (err) {
      console.error('Ошибка входа в комнату:', err);
      socket.emit('room-error', { message: 'Внутренняя ошибка при входе в комнату' });
    }
  });

  // Отправка сообщения
  socket.on('send-message', ({ text }) => {
    try {
      const roomId = socket.data.roomId;
      const username = socket.data.username;

      if (!roomId || !username) {
        return socket.emit('room-error', { message: 'Вы не подключены к комнате' });
      }

      const cleanText = (text || '').trim();
      if (!cleanText) return;

      // Проверяем, существует ли комната еще в БД
      const room = stmtGetRoom.get(roomId);
      if (!room) {
        return socket.emit('room-deleted', { message: 'Комната была удалена' });
      }

      const createdAt = Date.now();
      const insertResult = stmtInsertMessage.run(roomId, username, cleanText, createdAt);

      const messagePayload = {
        id: insertResult.lastInsertRowid,
        username,
        text: cleanText,
        createdAt
      };

      // Рассылаем всем участникам комнаты, включая отправителя
      io.to(roomId).emit('new-message', messagePayload);
    } catch (err) {
      console.error('Ошибка отправки сообщения:', err);
      socket.emit('room-error', { message: 'Не удалось отправить сообщение' });
    }
  });

  // Индикатор набора текста
  socket.on('typing', ({ isTyping }) => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;
    if (roomId && username) {
      socket.to(roomId).emit('user-typing', {
        username,
        isTyping: Boolean(isTyping)
      });
    }
  });

  // Удаление комнаты создателем
  socket.on('delete-room', ({ roomId, creatorKey }) => {
    try {
      if (!roomId || !creatorKey) {
        return socket.emit('room-error', { message: 'Не переданы данные для удаления комнаты' });
      }

      const room = stmtGetRoomWithKey.get(roomId);
      if (!room) {
        return socket.emit('room-error', { message: 'Комната не найдена' });
      }

      if (room.creator_key !== creatorKey) {
        return socket.emit('room-error', { message: 'Недостаточно прав: неверный ключ создателя' });
      }

      // Удаляем сообщения и комнату
      stmtDeleteMessages.run(roomId);
      stmtDeleteRoom.run(roomId);

      // Оповещаем всех подключенных участников
      io.to(roomId).emit('room-deleted', {
        roomId,
        message: 'Комната была удалена создателем.'
      });

      // Отключаем всех сокетов от комнаты
      const roomSockets = io.sockets.adapter.rooms.get(roomId);
      if (roomSockets) {
        for (const socketId of Array.from(roomSockets)) {
          const s = io.sockets.sockets.get(socketId);
          if (s) {
            s.leave(roomId);
            s.data.roomId = null;
          }
        }
      }

      console.log(`[Room Deleted] ID: ${roomId} успешно удалена создателем.`);
    } catch (err) {
      console.error('Ошибка удаления комнаты:', err);
      socket.emit('room-error', { message: 'Не удалось удалить комнату' });
    }
  });

  // Отключение сокета
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;
    if (roomId && username) {
      const remainingUsers = getRoomUsers(roomId);
      io.to(roomId).emit('user-left', {
        username,
        users: remainingUsers,
        usersCount: remainingUsers.length
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Cookie Talk server is running on http://localhost:${PORT}`);
});

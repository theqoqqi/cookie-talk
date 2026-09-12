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
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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
    image_url TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by_key TEXT,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_invites_room ON invites(room_id);

  CREATE TABLE IF NOT EXISTS members (
    member_key TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_id);
`);

// Миграция для существующих БД: добавляем колонку image_url при необходимости
try {
  db.exec('ALTER TABLE messages ADD COLUMN image_url TEXT;');
} catch (e) {
  // Колонка уже существует
}

// Подготовка SQL-запросов
const stmtGetRoom = db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?');
const stmtGetRoomWithKey = db.prepare('SELECT * FROM rooms WHERE id = ?');
const stmtCreateRoom = db.prepare('INSERT INTO rooms (id, name, creator_key, created_at) VALUES (?, ?, ?, ?)');
const stmtDeleteRoom = db.prepare('DELETE FROM rooms WHERE id = ?');
const stmtDeleteMessages = db.prepare('DELETE FROM messages WHERE room_id = ?');
const stmtDeleteInvites = db.prepare('DELETE FROM invites WHERE room_id = ?');
const stmtDeleteMembers = db.prepare('DELETE FROM members WHERE room_id = ?');
const stmtCreateInvite = db.prepare('INSERT INTO invites (token, room_id, created_at, used_at, used_by_key) VALUES (?, ?, ?, NULL, NULL)');
const stmtGetInvite = db.prepare('SELECT * FROM invites WHERE token = ? AND room_id = ?');
const stmtMarkInviteUsed = db.prepare('UPDATE invites SET used_at = ?, used_by_key = ? WHERE token = ?');
const stmtCreateMember = db.prepare('INSERT INTO members (member_key, room_id, username, created_at) VALUES (?, ?, ?, ?)');
const stmtGetMember = db.prepare('SELECT * FROM members WHERE member_key = ? AND room_id = ?');
const stmtGetMessages = db.prepare(`
  SELECT * FROM (
    SELECT id, username, text, image_url, created_at 
    FROM messages 
    WHERE room_id = ? 
    ORDER BY created_at DESC, id DESC 
    LIMIT 200
  ) 
  ORDER BY created_at ASC, id ASC
`);
const stmtInsertMessage = db.prepare('INSERT INTO messages (room_id, username, text, image_url, created_at) VALUES (?, ?, ?, ?, ?)');

// Генератор приятных ID комнат
const ADJECTIVES = ['crispy', 'sweet', 'golden', 'cozy', 'warm', 'magic', 'choco', 'sugar', 'honey', 'glazed', 'caramel', 'vanilla'];
const NOUNS = ['cookie', 'biscuit', 'waffle', 'donut', 'muffin', 'cake', 'brownie', 'cupcake', 'marshmallow', 'tea'];

function generateRoomId() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}`;
}

app.use(express.json({ limit: '12mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck эндпоинт для Docker и мониторинга
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// API: Загрузка изображения в комнату
app.post('/api/upload', (req, res) => {
  try {
    const { roomId, imageBase64 } = req.body || {};
    if (!roomId || !imageBase64) {
      return res.status(400).json({ success: false, error: 'Отсутствуют обязательные данные (roomId, imageBase64)' });
    }

    const room = stmtGetRoom.get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Комната не найдена' });
    }

    const matches = imageBase64.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ success: false, error: 'Неверный формат изображения' });
    }

    let ext = matches[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!['jpg', 'png', 'webp', 'gif'].includes(ext)) {
      return res.status(400).json({ success: false, error: 'Неподдерживаемый формат (разрешены JPG, PNG, WebP, GIF)' });
    }

    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Размер изображения превышает 8 МБ' });
    }

    const roomUploadDir = path.join(UPLOADS_DIR, roomId);
    if (!fs.existsSync(roomUploadDir)) {
      fs.mkdirSync(roomUploadDir, { recursive: true });
    }

    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const filePath = path.join(roomUploadDir, filename);

    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${roomId}/${filename}`;
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Ошибка сохранения изображения:', err);
    res.status(500).json({ success: false, error: 'Не удалось сохранить изображение' });
  }
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

// API: Создать одноразовую ссылку-приглашение
app.post('/api/rooms/:roomId/invites', (req, res) => {
  try {
    const { roomId } = req.params;
    const { creatorKey, memberKey } = req.body || {};

    const room = stmtGetRoom.get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Комната не найдена' });
    }

    // Проверяем права: либо создатель комнаты, либо подтвержденный участник
    let isAuthorized = false;
    if (creatorKey) {
      const roomWithKey = stmtGetRoomWithKey.get(roomId);
      if (roomWithKey && roomWithKey.creator_key === creatorKey) {
        isAuthorized = true;
      }
    }
    if (!isAuthorized && memberKey) {
      const member = stmtGetMember.get(memberKey, roomId);
      if (member) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: 'Недостаточно прав для создания приглашения' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const createdAt = Date.now();
    stmtCreateInvite.run(token, roomId, createdAt);

    res.json({
      success: true,
      token,
      inviteUrl: `/room/${roomId}?invite=${token}`
    });
  } catch (err) {
    console.error('Ошибка создания инвайта:', err);
    res.status(500).json({ success: false, error: 'Не удалось создать ссылку-приглашение' });
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
  socket.on('join-room', ({ roomId, username, creatorKey, memberKey, inviteToken }) => {
    try {
      if (!roomId || !username) {
        return socket.emit('room-error', { message: 'Укажите ID комнаты и имя пользователя' });
      }

      const room = stmtGetRoomWithKey.get(roomId);
      if (!room) {
        return socket.emit('room-not-found', { roomId });
      }

      const isCreator = Boolean(creatorKey && creatorKey === room.creator_key);
      let currentMemberKey = null;

      if (isCreator) {
        // Создатель комнаты имеет постоянный доступ
      } else if (memberKey && stmtGetMember.get(memberKey, roomId)) {
        // Подтвержденный участник, ранее активировавший одноразовую ссылку
        currentMemberKey = memberKey;
      } else if (inviteToken) {
        // Проверяем одноразовую ссылку-приглашение
        const invite = stmtGetInvite.get(inviteToken, roomId);
        if (!invite) {
          return socket.emit('room-error', { message: 'Недействительная ссылка-приглашение' });
        }
        if (invite.used_at) {
          return socket.emit('room-error', { message: 'Эта ссылка-приглашение уже была использована' });
        }

        // Активируем ссылку и выдаем постоянный ключ участника для этого браузера
        const now = Date.now();
        currentMemberKey = crypto.randomBytes(24).toString('hex');
        stmtMarkInviteUsed.run(now, currentMemberKey, inviteToken);
        stmtCreateMember.run(currentMemberKey, roomId, username.trim().slice(0, 32), now);
      } else {
        // Нет прав доступа
        return socket.emit('room-error', { message: 'Для входа в эту комнату требуется одноразовая ссылка-приглашение' });
      }

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
      socket.data.memberKey = currentMemberKey;

      // Получаем историю сообщений
      const history = stmtGetMessages.all(roomId).map(msg => ({
        id: msg.id,
        username: msg.username,
        text: msg.text,
        imageUrl: msg.image_url || null,
        createdAt: msg.created_at
      }));

      const currentUsers = getRoomUsers(roomId);

      // Отправляем подключившемуся клиенту подтверждение с историей и ключом участника
      socket.emit('room-joined', {
        roomId: room.id,
        name: room.name,
        createdAt: room.created_at,
        isCreator,
        memberKey: currentMemberKey,
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

  // Отправка сообщения (текст и/или изображение)
  socket.on('send-message', ({ text, imageUrl }) => {
    try {
      const roomId = socket.data.roomId;
      const username = socket.data.username;

      if (!roomId || !username) {
        return socket.emit('room-error', { message: 'Вы не подключены к комнате' });
      }

      const cleanText = (text || '').trim();
      const cleanImageUrl = (imageUrl || '').trim();
      if (!cleanText && !cleanImageUrl) return;

      // Проверяем, существует ли комната еще в БД
      const room = stmtGetRoom.get(roomId);
      if (!room) {
        return socket.emit('room-deleted', { message: 'Комната была удалена' });
      }

      const createdAt = Date.now();
      const insertResult = stmtInsertMessage.run(roomId, username, cleanText, cleanImageUrl || null, createdAt);

      const messagePayload = {
        id: insertResult.lastInsertRowid,
        username,
        text: cleanText,
        imageUrl: cleanImageUrl || null,
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

      // Удаляем инвайты, участников, сообщения и комнату
      stmtDeleteInvites.run(roomId);
      stmtDeleteMembers.run(roomId);
      stmtDeleteMessages.run(roomId);
      stmtDeleteRoom.run(roomId);

      // Удаляем загруженные файлы комнаты
      const roomUploadDir = path.join(UPLOADS_DIR, roomId);
      if (fs.existsSync(roomUploadDir)) {
        try {
          fs.rmSync(roomUploadDir, { recursive: true, force: true });
        } catch (e) {
          console.error(`Ошибка удаления файлов комнаты ${roomId}:`, e);
        }
      }

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

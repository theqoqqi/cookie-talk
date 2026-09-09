const { io } = require('socket.io-client');
const http = require('http');

const PORT = process.env.PORT || 7418;

async function runTests() {
  console.log(`--- Начинаем E2E тест Cookie Talk (Порт: ${PORT}) ---`);

  // 1. Создание комнаты через POST /api/rooms
  const createRoom = () => new Promise((resolve, reject) => {
    const postData = JSON.stringify({ name: 'Комната для E2E Теста' });
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/rooms',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  const roomData = await createRoom();
  console.log('✔ 1. Комната успешно создана на сервере:', roomData.roomId);

  const { roomId, creatorKey } = roomData;

  // 2. Подключение Создателя (Client 1)
  const client1 = io(`http://localhost:${PORT}`);
  const client2 = io(`http://localhost:${PORT}`);

  await new Promise((resolve) => client1.on('connect', resolve));
  await new Promise((resolve) => client2.on('connect', resolve));
  console.log('✔ 2. Оба клиента подключились к Socket.IO');

  // Client 1 входит как создатель
  const client1JoinPromise = new Promise((resolve) => {
    client1.on('room-joined', (data) => {
      if (data.isCreator === true) {
        console.log('✔ 3. Клиент 1 вошел с правами Создателя (isCreator: true)');
        resolve(data);
      }
    });
  });

  client1.emit('join-room', { roomId, username: 'Пекарь-Создатель', creatorKey });
  await client1JoinPromise;

  // Client 2 входит как гость (без creatorKey)
  const client2JoinPromise = new Promise((resolve) => {
    client2.on('room-joined', (data) => {
      if (data.isCreator === false) {
        console.log('✔ 4. Клиент 2 вошел как Участник (isCreator: false)');
        resolve(data);
      }
    });
  });

  const client1UserJoinedPromise = new Promise((resolve) => {
    client1.on('user-joined', (data) => {
      if (data.username === 'Гость-Собеседник') {
        console.log('✔ 5. Создатель получил оповещение о входе собеседника');
        resolve(data);
      }
    });
  });

  client2.emit('join-room', { roomId, username: 'Гость-Собеседник' });
  await Promise.all([client2JoinPromise, client1UserJoinedPromise]);

  // 6. Отправка сообщения от Клиента 2 Создателю
  const messagePromise = new Promise((resolve) => {
    client1.on('new-message', (msg) => {
      if (msg.text === 'Привет! Я пришел по ссылке!') {
        console.log('✔ 6. Создатель получил сообщение в реальном времени от Гостя');
        resolve(msg);
      }
    });
  });

  client2.emit('send-message', { text: 'Привет! Я пришел по ссылке!' });
  await messagePromise;

  // 7. Проверка индикатора набора текста
  const typingPromise = new Promise((resolve) => {
    client2.on('user-typing', (data) => {
      if (data.username === 'Пекарь-Создатель' && data.isTyping === true) {
        console.log('✔ 7. Гость видит индикатор набора текста Создателя');
        resolve(data);
      }
    });
  });

  client1.emit('typing', { isTyping: true });
  await typingPromise;

  // 8. Загрузка изображения через POST /api/upload
  const uploadImage = (imgBase64) => new Promise((resolve, reject) => {
    const postData = JSON.stringify({ roomId, imageBase64: imgBase64 });
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  // Тестовое 1x1 PNG изображение (data URL)
  const sampleBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const uploadRes = await uploadImage(sampleBase64);
  if (!uploadRes.success || !uploadRes.url.startsWith(`/uploads/${roomId}/`)) {
    throw new Error('Некорректный ответ от /api/upload: ' + JSON.stringify(uploadRes));
  }
  console.log('✔ 8. Изображение успешно загружено на сервер:', uploadRes.url);

  // 9. Отправка сообщения с картинкой и текстом от Создателя
  const imageMessagePromise = new Promise((resolve) => {
    client2.on('new-message', (msg) => {
      if (msg.imageUrl === uploadRes.url && msg.text === 'Посмотри на это фото!') {
        console.log('✔ 9. Гость получил сообщение с прикрепленным фото и текстом');
        resolve(msg);
      }
    });
  });

  client1.emit('send-message', { text: 'Посмотри на это фото!', imageUrl: uploadRes.url });
  await imageMessagePromise;

  // 10. Отправка сообщения только с картинкой (без текста)
  const imageOnlyPromise = new Promise((resolve) => {
    client1.on('new-message', (msg) => {
      if (msg.imageUrl === uploadRes.url && !msg.text) {
        console.log('✔ 10. Создатель получил сообщение с чистой картинкой (без текста)');
        resolve(msg);
      }
    });
  });

  client2.emit('send-message', { text: '', imageUrl: uploadRes.url });
  await imageOnlyPromise;

  // 11. Проверка получения истории с картинками новым участником (Client 3)
  const client3 = io(`http://localhost:${PORT}`);
  await new Promise((resolve) => client3.on('connect', resolve));

  const client3HistoryPromise = new Promise((resolve, reject) => {
    client3.on('room-joined', (data) => {
      const imgMsgs = data.history.filter(m => m.imageUrl);
      if (imgMsgs.length >= 2) {
        console.log('✔ 11. Новый участник успешно получил историю с сохраненными картинками (найдено:', imgMsgs.length, ')');
        resolve(data);
      } else {
        reject(new Error('В истории не найдены сообщения с картинками'));
      }
    });
  });

  client3.emit('join-room', { roomId, username: 'Фото-Наблюдатель' });
  await client3HistoryPromise;

  // 12. Удаление комнаты Создателем
  const client2DeletedPromise = new Promise((resolve) => {
    client2.on('room-deleted', (data) => {
      console.log('✔ 12. Гость получил событие удаления комнаты создателем');
      resolve(data);
    });
  });

  const client1DeletedPromise = new Promise((resolve) => {
    client1.on('room-deleted', (data) => {
      console.log('✔ 13. Создатель подтвердил удаление комнаты');
      resolve(data);
    });
  });

  client1.emit('delete-room', { roomId, creatorKey });
  await Promise.all([client2DeletedPromise, client1DeletedPromise]);

  // 13. Попытка войти в удаленную комнату
  const client4 = io(`http://localhost:${PORT}`);
  await new Promise((resolve) => client4.on('connect', resolve));

  const notFoundPromise = new Promise((resolve) => {
    client4.on('room-not-found', (data) => {
      console.log('✔ 14. Попытка входа в удаленную комнату вернула room-not-found');
      resolve(data);
    });
  });

  client4.emit('join-room', { roomId, username: 'Опоздавший' });
  await notFoundPromise;

  client1.disconnect();
  client2.disconnect();
  client3.disconnect();
  client4.disconnect();

  console.log('\n======================================================');
  console.log('🎉 ВСЕ E2E ТЕСТЫ (ВКЛЮЧАЯ КАРТИНКИ) УСПЕШНО ПРОЙДЕНЫ! 🎉');
  console.log('======================================================');
}

runTests().catch(err => {
  console.error('Ошибка в тестах:', err);
  process.exit(1);
});

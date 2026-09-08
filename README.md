# 🍪 Cookie Talk — Веб-чат с комнатами по ссылке

Легковесный браузерный чат с изолированными комнатами, постоянными ссылками, сохранением истории сообщений в SQLite и правами создателя на удаление чата.

---

## 🚀 Быстрый запуск через Docker (Рекомендуется для сервера)

### 1. Требования

* Установленный **Docker** и **Docker Compose** на сервере.

### 2. Запуск в одну команду

```bash
docker compose up -d --build
```

Приложение автоматически соберется и запустится на порту **7418** (или указанном в `.env`).

* Проверить статус контейнера:

  ```bash
  docker compose ps
  ```

* Просмотр логов:

  ```bash
  docker compose logs -f
  ```

* Остановить контейнер:

  ```bash
  docker compose down
  ```

> [!NOTE]
> Все данные (комнаты, сообщения и ключи создателей) сохраняются в директории `./data/chat.db` на хосте благодаря монтированию volume `./data:/app/data`, поэтому ваши данные не потеряются при перезапуске или обновлении контейнера.

---

## 🔒 Настройка Nginx с SSL (HTTPS и WSS для продакшена)

Для работы чата через домен с SSL-сертификатом (например, `chat.yourdomain.com`) настройте Nginx как Reverse Proxy:

```nginx
server {
    listen 80;
    server_name chat.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name chat.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/chat.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7418;
        proxy_http_version 1.1;
        
        # Заголовки для WebSocket (Socket.IO)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 💻 Локальный запуск без Docker

Если у вас установлен **Node.js v22+**:

```bash
# 1. Установка зависимостей
npm install

# 2. Запуск сервера
npm start
```

Чат откроется на `http://localhost:7418`.

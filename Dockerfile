# Базовый легковесный образ Node.js 22 (LTS) на Alpine Linux
FROM node:22-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Переменные окружения по умолчанию
ENV NODE_ENV=production \
    PORT=7418

# Копируем манифесты зависимостей
COPY package*.json ./

# Устанавливаем только production-зависимости
RUN npm ci --omit=dev && npm cache clean --force

# Копируем исходный код приложения
COPY server.js ./
COPY public ./public

# Создаем папку для базы данных SQLite
RUN mkdir -p /app/data

# Открываем порт сервиса
EXPOSE 7418

# Проверка работоспособности контейнера
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:7418/health || exit 1

# Запуск приложения
CMD ["node", "--no-warnings", "server.js"]

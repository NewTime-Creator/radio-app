# Използвай Node.js 18
FROM node:18-alpine

# Работна директория
WORKDIR /app

# Копирай package files
COPY package*.json ./

# Инсталирай dependencies
RUN npm install --production

# Копирай всички файлове
COPY . .

# Порт
EXPOSE 3001

# Стартирай сървъра
CMD ["npm", "start"]
# --- FIX 1: Use Node 20 Alpine to match package.json engine requirement ---
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first to take advantage of caching
COPY package*.json ./

# --- FIX 2: Install dependencies with correct Node version ---
# Use --omit=dev for production, as recommended by npm 10+
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# --- FIX 3: Ensure environment variable PORT is respected ---
ENV PORT=3001

# Expose the port that the app listens on
EXPOSE 3001

# --- FIX 4: Start the app using npm start ---
CMD ["npm", "start"]

FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY index.js ./

# Expose the server port
EXPOSE 3000

CMD ["node", "index.js"]

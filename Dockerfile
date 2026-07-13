# Remove dist folder completely - force clean rebuild
FROM node:20-alpine
WORKDIR /app
RUN rm -rf dist/
COPY package*.json ./
RUN npm install --no-cache
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]

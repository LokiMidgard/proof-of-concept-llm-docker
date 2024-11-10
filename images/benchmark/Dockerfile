FROM node:20-alpine


WORKDIR /app

COPY code/package.json /app/package.json
RUN npm install

COPY code/src /app/src

ENTRYPOINT [ "npm","run", "run" ] 
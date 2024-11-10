FROM node:20-alpine


RUN apk add --no-cache git openssh-client

WORKDIR /app

COPY code/package.json /app/package.json
RUN npm install

COPY code/src /app/src
RUN echo "foo"
ENTRYPOINT [ "npm","run", "run" ] 
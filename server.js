const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Arena } = require("./gameEngine");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const arena = new Arena();

app.use(express.static("public"));

const emitState = () => {
    io.emit("update", arena.toJSON());
};

io.on("connection", (socket) => {
    socket.on("join", (username) => {
        arena.addViewer(username);
        emitState();
    });

    socket.on("gift", ({ username, gift }) => {
        arena.applyGift(username, gift);
        emitState();
    });

    socket.on("leave", (username) => {
        arena.removeViewer(username);
        emitState();
    });

    emitState();
});

setInterval(() => {
    arena.nextTurn();
    emitState();
}, 1200);

server.listen(3000, () => {
    console.log("Running on http://localhost:3000");
});

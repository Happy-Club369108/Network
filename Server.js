const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// MongoDB
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log(" MongoDB Connected"))
    .catch((err) => console.error(" MongoDB Error:", err.message));

// Schemas
const userSchema = new mongoose.Schema({
    number: { type: String, unique: true, required:true },
    password: String,
    name: String,
    avatar: String,
    contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
});

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    text: String,
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Message = mongoose.model("Message", messageSchema);

// Auth
app.post("/signup", async (req, res) => {
    const { number, password, name } = req.body;
    const existing = await User.findOne({ number });
    if (existing) return res.status(400).json({ error: "User already exists!" });

    const hash = await bcrypt.hash(password, 10);
    const newUser = await new User({ number, name, password: hash }).save();
    res.json({ userId: newUser._id });
});

app.post("/login", async (req, res) => {
    const { number, password } = req.body;
    const user = await User.findOne({ number });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    res.json({ userId: user._id });
});

// Chat list
app.get("/chatlist/:userId", async (req, res) => {
    const { userId } = req.params;
    const user = await User.findById(userId).populate("contacts", "name avatar");
    if (!user) return res.status(404).json({ error: "User not found" });

    const chatList = await Promise.all(
        user.contacts.map(async (contact) => {
            const lastMsg = await Message.findOne({
                $or: [
                    { sender: userId, receiver: contact._id },
                    { sender: contact._id, receiver: userId },
                ],
            }).sort({ createdAt: -1 });

            return {
                contactId: contact._id,
                name: contact.name,
                avatar: contact.avatar,
                lastMessage: lastMsg?.text || null,
                lastMessageAt: lastMsg?.createdAt || null,
            };
        })
    );

    res.json(chatList);
});

// Messages
app.get("/messages/:userId/:contactId", async (req, res) => {
    const { userId, contactId } = req.params;
    const messages = await Message.find({
        $or: [
            { sender: userId, receiver: contactId },
            { sender: contactId, receiver: userId },
        ]
    }).sort({ createdAt: 1 });

    res.json(messages);
});

// Contacts
app.get("/contacts/:userId", async (req, res) => {
    const user = await User.findById(req.params.userId).populate("contacts", "name number avatar");
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json(user.contacts);
});

app.get("/search/:number", async (req, res) => {
    const user = await User.findOne({ number: req.params.number }, "name avatar number");
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json(user);
});

app.post("/contacts/add", async (req, res) => {
    const { userId, contactId } = req.body;
    const user = await User.findById(userId);
    const contact = await User.findById(contactId);

    if (!user || !contact) return res.status(404).json({ error: "User or contact not found" });

    if (!user.contacts.includes(contactId)) {
        user.contacts.push(contactId);
        await user.save();
    }

    res.json({ success: true });
});

app.delete("/contacts/remove", async (req, res) => {
    const { userId, contactId } = req.body;
    await User.findByIdAndUpdate(userId, { $pull: { contacts: contactId } });
    res.json({ success: true });
});

// Profile
app.get("/profile/:userId", async (req, res) => {
    const user = await User.findById(req.params.userId, "name number avatar contacts");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
});

// Socket.IO
const onlineUsers = {};

io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    onlineUsers[userId] = socket.id;

    socket.on("disconnect", () => delete onlineUsers[userId]);

    socket.on("sendmessage", async ({ sender, receiver, text }) => {
        await new Message({ sender, receiver, text }).save();
        const targetSocket = onlineUsers[receiver];
        if (targetSocket) io.to(targetSocket).emit("receivemessage", { sender, text });
    });

    socket.on("call-user", ({ from, to, offer }) => {
        const targetSocket = onlineUsers[to];
        if (targetSocket) io.to(targetSocket).emit("incoming-call", { from, offer });
    });

    socket.on("answer-call", ({ from, to, answer }) => {
        const targetSocket = onlineUsers[to];
        if (targetSocket) io.to(targetSocket).emit("call-answered", { from, answer });
    });

    socket.on("ice-candidate", ({ from, to, candidate }) => {
        const targetSocket = onlineUsers[to];
        if (targetSocket) io.to(targetSocket).emit("ice-candidate", { from, candidate });
    });

    socket.on("reject-call", ({ from, to }) => {
        const targetSocket = onlineUsers[to];
        if (targetSocket) io.to(targetSocket).emit("call-rejected", { from })
    })

    socket.on("end-call", ({ from, to }) => {
        const targetSocket = onlineUsers[to];
        if (targetSocket) io.to(targetSocket).emit("call-ended", { from })
    })

});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

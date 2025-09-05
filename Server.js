require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ---------------- MongoDB ----------------
mongoose.connect(process.env.MONGO_URL || "mongodb://localhost:27017/miniMALL")
  .then(() => console.log("MongoDB connected"))
  .catch(console.log);

// ---------------- Schemas ----------------
const userSchema = new mongoose.Schema({
  avatar: String,
  name: String,
  number: { type: String, unique: true },
  password: String,
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
});

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  text: String,
  seen: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);
const Message = mongoose.model("Message", messageSchema);

// ---------------- REST APIs ----------------
app.post("/signup", async (req, res) => {
  try {
    const { name, number, password } = req.body;
    if (!name || !number || !password) return res.status(400).json({ message: "All fields required" });

    if (await User.findOne({ number })) return res.status(400).json({ message: "Number already exists" });

    const hash = await bcrypt.hash(password, 10);
    const user = await new User({ name, number, password: hash }).save();
    res.json({ userId: user._id });
  } catch { res.status(500).json({ message: "Server error" }); }
});

app.post("/login", async (req, res) => {
  try {
    const { number, password } = req.body;
    const user = await User.findOne({ number });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: "Wrong password" });
    res.json({ userId: user._id });
  } catch { res.status(500).json({ message: "Server error" }); }
});

app.get("/profile/:userId", async (req, res) => {
  const user = await User.findById(req.params.userId).select("-password");
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(user);
});

app.get("/contacts/:userId", async (req, res) => {
  const user = await User.findById(req.params.userId).populate("contacts", "name avatar number");
  res.json(user?.contacts || []);
});

app.post("/friends/:userId/:friendId", async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user.contacts.includes(req.params.friendId)) {
    user.contacts.push(req.params.friendId);
    await user.save();
  }
  res.json({ message: "Friend added" });
});

app.get("/messages/:userId/:contactId", async (req, res) => {
  const { userId, contactId } = req.params;
  const msgs = await Message.find({
    $or: [
      { sender: userId, receiver: contactId },
      { sender: contactId, receiver: userId },
    ],
  }).sort({ createdAt: 1 });
  res.json(msgs);
});

// ---------------- Socket.IO ----------------
const onlineUsers = new Map();

io.on("connection", socket => {
  console.log("Socket connected:", socket.id);

  socket.on("join", userId => {
    onlineUsers.set(userId, socket.id);
    socket.emit("onlineUsers", [...onlineUsers.keys()]);
  });

  socket.on("sendMessage", async ({ senderId, receiverId, text }) => {
    const msg = await new Message({ sender: senderId, receiver: receiverId, text }).save();
    [senderId, receiverId].forEach(id => {
      const sock = onlineUsers.get(id);
      if (sock) io.to(sock).emit("receiveMessage", msg);
    });
  });

  socket.on("callUser", ({ to, from, signalData, name, callType }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target).emit("incomingCall", { from, signalData, name, callType, online: true });
    else socket.emit("calleeOffline", { to, name, callType });
  });

  socket.on("answerCall", ({ to, signalData }) => {
    const caller = onlineUsers.get(to);
    if (caller) io.to(caller).emit("callAccepted", { signalData });
  });

  socket.on("rejectCall", ({ to }) => {
    const caller = onlineUsers.get(to);
    if (caller) io.to(caller).emit("callEnded", { reason: "Call rejected" });
  });

  socket.on("iceCandidate", ({ to, candidate }) => {
    const peer = onlineUsers.get(to);
    if (peer) io.to(peer).emit("iceCandidate", candidate);
  });

  socket.on("endCall", ({ to }) => {
    const peer = onlineUsers.get(to);
    if (peer) io.to(peer).emit("callEnded");
  });

  socket.on("disconnect", () => {
    for (const [uid, sid] of onlineUsers.entries()) {
      if (sid === socket.id) {
        onlineUsers.delete(uid);
        socket.broadcast.emit("userOffline", uid);
        break;
      }
    }
    console.log("Socket disconnected:", socket.id);
  });
});

server.listen(process.env.PORT || 5000, () => console.log("Server running"));

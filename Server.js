// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose
  .connect(
    "mongodb+srv://happyclub369108:PJYKlE3sAPjRahOl@cluster0.x6ooz8n.mongodb.net/miniMALL?retryWrites=true&w=majority"
  )
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log(err));

// ---------------- Schemas ----------------
const userSchema = new mongoose.Schema({
  avatar: String,
  name: String,
  number: { type: String },
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

// ---------------- Routes ----------------

// Signup
app.post("/signup", async (req, res) => {
  try {
    const { name, number, password } = req.body;
    const exist = await User.findOne({ number });
    if (exist) return res.status(400).json({ message: "Number already exists" });

    const hash = await bcrypt.hash(password, 10);
    const newUser = await new User({ name, number, password: hash }).save();
    res.json({ userId: newUser._id });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { number, password } = req.body;
    const user = await User.findOne({ number });
    if (!user) return res.status(404).json({ message: "User not found" });

    const compare = await bcrypt.compare(password, user.password);
    if (!compare) return res.status(400).json({ message: "Wrong password" });

    res.json({ userId: user._id });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Get profile
app.get("/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Search contacts
app.get("/search/:userId/:query", async (req, res) => {
  const { userId, query } = req.params;
  const user = await User.findById(userId);
  const contacts = await User.find({
    _id: { $ne: userId, $nin: user.contacts },
    number: { $regex: query, $options: "i" },
  });
  res.json(contacts);
});

// Add friend
app.post("/friends/:userId/:friendId", async (req, res) => {
  const { userId, friendId } = req.params;
  const user = await User.findById(userId);
  if (!user.contacts.includes(friendId)) {
    user.contacts.push(friendId);
    await user.save();
  }
  res.json({ message: "Friend added" });
});

// Get contacts
app.get("/contacts/:userId", async (req, res) => {
  const { userId } = req.params;
  const user = await User.findById(userId).populate("contacts", "name avatar number");
  res.json(user.contacts);
});

// Get messages
app.get("/messages/:userId/:contactId", async (req, res) => {
  const { userId, contactId } = req.params;
  const messages = await Message.find({
    $or: [
      { sender: userId, receiver: contactId },
      { sender: contactId, receiver: userId },
    ],
  }).sort({ createdAt: 1 });
  res.json(messages);
});

// ---------------- Socket.IO ----------------
const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join user
  socket.on("join", (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log(`User ${userId} joined. Online users:`, [...onlineUsers.keys()]);
  });

  // Send message
  socket.on("sendMessage", async ({ senderId, receiverId, text }) => {
    try {
      const message = await new Message({ sender: senderId, receiver: receiverId, text }).save();

      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit("receiveMessage", {
          _id: message._id,
          sender: senderId,
          receiver: receiverId,
          text,
          createdAt: message.createdAt,
        });
      }

      // Echo to sender
      socket.emit("receiveMessage", {
        _id: message._id,
        sender: senderId,
        receiver: receiverId,
        text,
        createdAt: message.createdAt,
      });
    } catch (err) {
      console.log("Message send error:", err);
    }
  });

  // Call user
  socket.on("callUser", ({ to, from, signalData, name, callType }) => {
    const calleeSocket = onlineUsers.get(to);
    if (calleeSocket) {
      io.to(calleeSocket).emit("incomingCall", { from, signalData, name, callType, online: true });
    } else {
      const callerSocket = onlineUsers.get(from);
      if (callerSocket) {
        io.to(callerSocket).emit("calleeOffline", { to, name, callType });
      }
    }
  });

  // Accept call
  socket.on("answerCall", ({ to, signalData }) => {
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) io.to(callerSocket).emit("callAccepted", { signalData });
  });

  // Reject call
  socket.on("rejectCall", ({ to }) => {
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) io.to(callerSocket).emit("callEnded", { reason: "Call rejected" });
  });

  // ICE candidate
  socket.on("iceCandidate", ({ to, candidate }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) io.to(targetSocket).emit("iceCandidate", candidate);
  });

  // End call
  socket.on("endCall", ({ to }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) io.to(targetSocket).emit("callEnded");
  });

  // Disconnect
  socket.on("disconnect", () => {
    for (const [userId, sockId] of onlineUsers.entries()) {
      if (sockId === socket.id) {
        onlineUsers.delete(userId);
        break;
      }
    }
    console.log("Socket disconnected:", socket.id);
  });
});

// ---------------- Start Server ----------------
server.listen(5000, () => console.log("Server running on port 5000"));

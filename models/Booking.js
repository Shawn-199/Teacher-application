const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  childName: String,
  parentName: String,
  email: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  level: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Booking", bookingSchema);

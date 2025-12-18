const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_KEY);
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.pwy4qnn.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("ticket-db");
    const ticketCollection = db.collection("tickets");
    const bookingCollection = db.collection("bookings");
    // Read tickets
    app.get("/tickets", async (req, res) => {
      const result = await ticketCollection.find().toArray();
      res.send(result);
    });

    app.get("/all-tickets/:id", async (req, res) => {
      const { id } = req.params;
      const objectId = new ObjectId(id);
      const result = await ticketCollection.findOne({ _id: objectId });

      res.send({
        success: true,
        result,
      });
    });

    // create new tickets
    app.post("/tickets", async (req, res) => {
      const data = req.body;
      if (data.quantity) {
        data.quantity = parseInt(data.quantity);
        if (isNaN(data.quantity)) {
          return res
            .status(400)
            .send({ message: "Quantity must be a valid number." });
        }
      }
      const result = await ticketCollection.insertOne(data);
      res.send({
        success: true,
        result,
      });
    });

    // READ TICKETS BY VENDOR EMAIL
    app.get("/my-tickets", async (req, res) => {
      const email = req.query.email;
      const cursor = ticketCollection.find({ vendorEmail: email });
      const result = await cursor.toArray();
      res.send(result);
    });

    // update ticket
    app.patch("/all-tickets/:id", async (req, res) => {
      const { id } = req.params;
      const data = req.body;
      const ticketId = new ObjectId(id);
      delete data._id;

      const filter = { _id: ticketId };
      const update = {
        $set: data,
      };
      const result = await ticketCollection.updateOne(filter, update);

      res.send(result);
    });

    // Delete ticket
    app.delete("/all-tickets/:id", async (req, res) => {
      const { id } = req.params;
      const ticketId = new ObjectId(id);

      const result = await ticketCollection.deleteOne({
        _id: ticketId,
      });

      res.send(result);
    });

    //  booking tickets
    app.post("/bookings", async (req, res) => {
      try {
        const bookingData = req.body;
        if (!ObjectId.isValid(bookingData.ticketId)) {
          return res.status(400).send({ message: "Invalid ticket ID." });
        }

        bookingData.createdAt = new Date();

        const bookingResult = await bookingCollection.insertOne(bookingData);

        res.status(201).send({
          success: true,
          message:
            "Booking created! Please complete payment to reserve your seat.",
          insertedBookingId: bookingResult.insertedId,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to create booking." });
      }
    });
    // read ticket by user email
    app.get("/my-bookings", async (req, res) => {
      const email = req.query.email;
      const cursor = bookingCollection.find({ vendorEmail: email });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/bookings/:id", async (req, res) => {
      const { id } = req.params;
      const objectId = new ObjectId(id);
      const result = await bookingCollection.findOne({ _id: objectId });

      res.send({
        success: true,
        result,
      });
    });

    // Delete booking and restore ticket quantity
    app.delete("/bookings/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const bookingId = new ObjectId(id);
        const booking = await bookingCollection.findOne({ _id: bookingId });

        if (!booking) {
          return res
            .status(404)
            .send({ success: false, message: "Booking not found." });
        }

        const { ticketId, bookingQuantity } = booking;

        const updateTicketResult = await ticketCollection.updateOne(
          { _id: new ObjectId(ticketId) },
          { $inc: { quantity: Number(bookingQuantity) } }
        );

        const deleteResult = await bookingCollection.deleteOne({
          _id: bookingId,
        });

        if (deleteResult.deletedCount === 1) {
          res.send({
            success: true,
            message: "Booking cancelled and ticket quantity restored.",
            deleteResult,
          });
        } else {
          res
            .status(500)
            .send({ success: false, message: "Failed to delete booking." });
        }
      } catch (error) {
        console.error("Error deleting booking:", error);
        res
          .status(500)
          .send({ success: false, message: "Server error during deletion." });
      }
    });

    // payment api
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = Math.round(parseFloat(paymentInfo.cost) * 100);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.ticketTitle,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.bookedBy,
        mode: "payment",
        metadata: {
          ticketId: paymentInfo.ticketId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    //  update booking status and reduce quantity
    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId)
          return res
            .status(400)
            .send({ success: false, message: "Missing session_id" });

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const bookingId = session.metadata.ticketId;

          const booking = await bookingCollection.findOne({
            _id: new ObjectId(bookingId),
          });

          if (!booking) {
            return res
              .status(404)
              .send({ success: false, message: "Booking not found" });
          }

          if (booking.bookingStatus === "paid") {
            return res.send({ success: true, message: "Already updated" });
          }

          const ticket = await ticketCollection.findOne({
            _id: new ObjectId(booking.ticketId),
          });

          if (!ticket) {
            return res
              .status(404)
              .send({ success: false, message: "Original ticket not found" });
          }

          const currentQuantity = parseInt(ticket.quantity) || 0;
          const bookedQuantity = parseInt(booking.bookingQuantity) || 0;
          const newQuantity = currentQuantity - bookedQuantity;

          await bookingCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            { $set: { bookingStatus: "paid" } }
          );

          const updateTicketResult = await ticketCollection.updateOne(
            { _id: new ObjectId(booking.ticketId) },
            { $set: { quantity: newQuantity } }
          );

          return res.send({
            success: true,
            message: "Payment successful and quantity updated.",
            updatedQuantity: newQuantity,
          });
        }

        res
          .status(400)
          .send({ success: false, message: "Payment not verified" });
      } catch (error) {
        console.error("Update Error:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is fine");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

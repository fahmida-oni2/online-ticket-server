const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_KEY);
const app = express();
const port = 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./online-ticket-platform-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

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
    const userCollection = db.collection("users");
    const vendorCollection = db.collection("vendor");
    const ticketCollection = db.collection("tickets");
    const bookingCollection = db.collection("bookings");
    const paymentCollection = db.collection("payments");

    // user related api
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: "user exists" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // vendor related api:
    app.post("/vendor", async (req, res) => {
      const vendor = req.body;
      vendor.status = "pending";
      vendor.createdAt = new Date();

      const result = await vendorCollection.insertOne(vendor);
      res.send(result);
    });
    // Update user role to vendor
    app.patch("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const { role } = req.body;

      const filter = { email: email };
      const updatedDoc = {
        $set: {
          role: role,
        },
      };

      const result = await userCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    // update status
    app.patch("/vendor/status/:id", verifyFBToken, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: status,
        },
      };

      const result = await vendorCollection.updateOne(query, updatedDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "vendor",
          },
        };
        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser
        );
      }

      res.send(result);
    });

    app.get("/vendor", async (req, res) => {
      try {
        const email = req.query.email;
        if (email) {
          const result = await vendorCollection.findOne({ email: email });
          res.send(result);
        } else {
          const result = await vendorCollection.find().toArray();
          res.send(result);
        }
      } catch (error) {
        res.status(500).send({ message: "Error fetching vendor data", error });
      }
    });

    // update ticket
    app.patch("/vendor/edit-ticket/:id", async (req, res) => {
      const { id } = req.params;
      const data = req.body;
      const ticketId = new ObjectId(id);
      delete data._id;
      delete data.status;
      delete data.vendorEmail;

      const filter = { _id: ticketId };
      const update = {
        $set: data,
      };
      const result = await vendorCollection.updateOne(filter, update);

      res.send(result);
    });

    // Delete ticket
    app.delete("/vendor/:id", async (req, res) => {
      const { id } = req.params;
      const ticketId = new ObjectId(id);

      const result = await vendorCollection.deleteOne({
        _id: ticketId,
      });

      res.send(result);
    });

    // Read data from vendor collection
    app.get("/my-tickets", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email)
          return res.status(400).send({ message: "Email query is required" });
        const query = { vendorEmail: email };
        const result = await vendorCollection.find(query).toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error", error });
      }
    });
    // read
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.findOne({ email });
      res.send(result);
    });

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

      if (data.vendorEmail) {
        await userCollection.updateOne(
          { email: data.vendorEmail },
          { $set: { role: "vendor" } }
        );
      }

      res.send({
        success: true,
        result,
      });
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

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // create payments

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
          ticketTitle: paymentInfo.ticketTitle,
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
        // console.log(session);

        const transactionId = session.payment_intent;
        const query = { transactionId: transactionId };

        const paymentExist = await paymentCollection.findOne(query);
        console.log(paymentExist);
        if (paymentExist) {
          const relatedBooking = await bookingCollection.findOne({
            _id: new ObjectId(session.metadata.ticketId),
          });
          return res.send({
            message: "already exists",
            transactionId,
            trackingId:
              paymentExist.trackingId ||
              (relatedBooking ? relatedBooking.trackingId : "N/A"),
          });
        }
        const trackingId = session.metadata.trackingId;

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
          const trackingId = generateTrackingId();
          await bookingCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            {
              $set: { bookingStatus: "paid", trackingId: trackingId },
            }
          );

          const updateTicketResult = await ticketCollection.updateOne(
            { _id: new ObjectId(booking.ticketId) },
            { $set: { quantity: newQuantity } }
          );

          const paymentHistory = {
            amount: session.amount_total,
            currency: session.currency,
            customerEmail: session.customer_email,
            ticketId: session.metadata.ticketId,
            ticketTitle: session.metadata.ticketTitle,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };

          if (session.payment_status === "paid") {
            const resultPayment = await paymentCollection.insertOne(
              paymentHistory
            );
            return res.send({
              success: true,
              message: "Payment successful and quantity updated.",
              updatedQuantity: newQuantity,
              modifyTicket: updateTicketResult,
              trackingId: trackingId,
              transactionId: session.payment_intent,
              paymentInfo: resultPayment,
            });
          }
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

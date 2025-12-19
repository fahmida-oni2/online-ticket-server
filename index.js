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
    // console.log("decoded in the token", decoded);
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

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };
    // user related api

    app.get("/users", verifyFBToken, async (req, res) => {
      const query = {};
      const cursor = userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });
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

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await userCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    // for making fraud
    app.patch(
      "/users/fraud/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };

        const user = await userCollection.findOne(filter);
        if (!user) return res.status(404).send({ message: "User not found" });

        const updatedDoc = {
          $set: { status: "fraud" },
        };
        const result = await userCollection.updateOne(filter, updatedDoc);

        if (user.role === "vendor") {
          await ticketCollection.updateMany(
            { vendorEmail: user.email },
            { $set: { isHidden: true } }
          );
        }

        res.send(result);
      }
    );

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
      const result = await vendorCollection.findOne({ _id: objectId });

      res.send({
        success: true,
        result,
      });
    });

    // approved tickets apis
    app.get("/approved-tickets", verifyFBToken, async (req, res) => {
  try {
    const { from, to, type, sort } = req.query; 

    const query = { status: "approved" };
    const searchConditions = [];

    if (from && from.trim() !== "") {
      searchConditions.push({ fromLocation: { $regex: from, $options: 'i' } });
    }
    
    if (to && to.trim() !== "") {
      searchConditions.push({ toLocation: { $regex: to, $options: 'i' } });
    }
    
    if (type && type !== 'All') {
      searchConditions.push({ transportType: type });
    }

    if (searchConditions.length > 0) {
      query.$and = [
        { status: "approved" }, 
        ...searchConditions
      ];
    }
    let sortOptions = {};
    if (sort === "lowToHigh") {
      sortOptions = { price: 1 }; 
    } else if (sort === "highToLow") {
      sortOptions = { price: -1 }; 
    }

    const result = await vendorCollection.find(query).sort(sortOptions).toArray();
    res.send({ success: true, data: result });

  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).send({ message: "Server error", error: error.message });
  }
});
// for making advertise
    app.patch("/tickets/advertise/:id",verifyFBToken,verifyAdmin,async (req, res) => {
        const id = req.params.id;
        const { isAdvertised } = req.body;

        if (isAdvertised === true) {
          const count = await vendorCollection.countDocuments({
            isAdvertised: true,
          });
          if (count >= 6) {
            return res.status(400).send({
              success: false,
              message: "Maximum advertisement limit (6) reached.",
            });
          }
        }

        const query = { _id: new ObjectId(id) };
        const updateDoc = { $set: { isAdvertised } };
        const result = await vendorCollection.updateOne(query, updateDoc);

        res.send({ success: true, result });
      }
    );

    app.get("/advertisements", async (req, res) => {
      const query = { isAdvertised: true, status: "approved" };
      const result = await vendorCollection.find(query).limit(6).toArray();
      res.send(result);
    });

    app.get("/latest-tickets", async (req, res) => {
      const query = { status: "approved" };
      const result = await vendorCollection
        .find(query)
        .sort({ postedDate: -1 })
        .limit(6)
        .toArray();
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
      const cursor = bookingCollection.find({ customerEmail: email });
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

    app.get("/vendor/bookings", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const query = { vendorEmail: email };
      const result = await bookingCollection.find(query).toArray();
      res.send(result);
    });

    // Update booking status
    app.patch("/bookings/status/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const filter = { _id: new ObjectId(id) };

      const updatedDoc = {
        $set: { status: status },
      };

      const result = await bookingCollection.updateOne(filter, updatedDoc);
      res.send(result);
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
        customer_email: paymentInfo.customerEmail,
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
        console.log(session);

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

          const ticket = await vendorCollection.findOne({
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
              $set: {
                bookingStatus: "paid",
                status: "paid",
                trackingId: trackingId,
              },
            }
          );

          const updateTicketResult = await vendorCollection.updateOne(
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


    // pipeline:
app.get('/vendor/revenue',verifyFBToken,async (req, res) => {

  const email = req.decoded_email;

    if (!email) {
        return res.status(401).send({ message: "Unauthorized access: No email in token" });
    }

    try {
        const bookingStats = await bookingCollection.aggregate([
            { 
                $match: { 
                    status: "paid", 
                    vendorEmail: email 
                } 
            },
            { 
                $group: { 
                    _id: null, 
                    rev: { 
                        $sum: { 
                            $multiply: [
                                { $toDouble: { $ifNull: ["$bookingQuantity", 0] } }, 
                                { $toDouble: { $ifNull: ["$unitPrice", 0] } }
                            ] 
                        } 
                    }, 
                    sold: { $sum: { $toDouble: { $ifNull: ["$bookingQuantity", 0] } } } 
                } 
            }
        ]).toArray();

        const ticketStats = await vendorCollection.aggregate([
            { $match: { status: "approved", vendorEmail: email } },
            { $group: { _id: null, added: { $sum: { $toDouble: { $ifNull: ["$quantity", 0] } } } } }
        ]).toArray();

        res.send({
          success: true,
            totalRevenue: bookingStats[0]?.rev || 0,
            totalTicketsSold: bookingStats[0]?.sold || 0,
            totalTicketsAdded: ticketStats[0]?.added || 0
        });

    } catch (error) {
        console.error("Aggregation Error:", error);
        res.status(500).send({ message: "Server error", error: error.message });
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

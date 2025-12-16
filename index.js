const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
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
             return res.status(400).send({ message: "Quantity must be a valid number." });
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
  //  booking ticket and update quantity
    app.post("/bookings", async (req, res) => {
        try {
            const bookingData = req.body;
            const { ticketId, bookingQuantity } = bookingData;
      
            if (!ticketId || !bookingQuantity || bookingQuantity <= 0) {
                return res.status(400).send({ message: "Missing or invalid booking details." });
            }
            if (!ObjectId.isValid(ticketId)) {
                return res.status(400).send({ message: "Invalid ticket ID format for booking." });
            }
            const ticketObjectId = new ObjectId(ticketId);
            const existingTicket = await ticketCollection.findOne({ _id: ticketObjectId }, { projection: { quantity: 1 } });
            if (!existingTicket) {
            return res.status(404).send({ message: "Ticket not found." });
        }
           const currentQuantity = Number(existingTicket.quantity);
        const quantityToReduce = Number(bookingQuantity);
if (isNaN(currentQuantity) || isNaN(quantityToReduce)) {
             return res.status(500).send({ message: "Ticket quantity or booking quantity is not a valid number." });
        }

        const newQuantity = currentQuantity - quantityToReduce;
        
        if (newQuantity < 0) {
             return res.status(400).send({ message: "Not enough tickets available for this booking." });
        }
        bookingData.createdAt = new Date();
        const bookingResult = await bookingCollection.insertOne(bookingData);
            const updateTicketResult = await ticketCollection.updateOne(
                { _id: ticketObjectId },
                { $set: { quantity: newQuantity } }
            );
     
            if (updateTicketResult.modifiedCount !== 1) {
                console.warn(`Booking inserted, but ticket quantity update failed for ID: ${ticketId}`);
              
            }

            res.status(201).send({
                success: true,
                message: "Ticket booked successfully! Status: Pending",
                insertedBookingId: bookingResult.insertedId,
            });
        } catch (error) {
            console.error("Error processing booking:", error);
            res.status(500).send({ message: "Failed to process booking." });
        }
    });

// read ticket by user email
app.get("/my-bookings", async (req, res) => {
      const email = req.query.email;
      const cursor = bookingCollection.find({ vendorEmail: email });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Delete booking and restore ticket quantity
app.delete("/bookings/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = new ObjectId(id);
    const booking = await bookingCollection.findOne({ _id: bookingId });

    if (!booking) {
      return res.status(404).send({ success: false, message: "Booking not found." });
    }

    const { ticketId, bookingQuantity } = booking;

    const updateTicketResult = await ticketCollection.updateOne(
      { _id: new ObjectId(ticketId) },
      { $inc: { quantity: Number(bookingQuantity) } } // $inc adds the value back
    );

    const deleteResult = await bookingCollection.deleteOne({ _id: bookingId });

    if (deleteResult.deletedCount === 1) {
      res.send({
        success: true,
        message: "Booking cancelled and ticket quantity restored.",
        deleteResult,
      });
    } else {
      res.status(500).send({ success: false, message: "Failed to delete booking." });
    }
  } catch (error) {
    console.error("Error deleting booking:", error);
    res.status(500).send({ success: false, message: "Server error during deletion." });
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

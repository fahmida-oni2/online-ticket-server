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
    // Read tickets
    app.get("/tickets", async (req, res) => {
      const result = await ticketCollection.find().toArray();
      res.send(result);
    });

    // create new tickets
    app.post("/tickets", async (req, res) => {
      const data = req.body;
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

    app.delete("/all-tickets/:id", async (req, res) => {
      const { id } = req.params;
      const ticketId = new ObjectId(id);

      const result = await ticketCollection.deleteOne({
        _id: ticketId,
      });

      res.send(result);
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

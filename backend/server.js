const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const products = [
  { id: 1, name: "Sauce Labs Backpack", price: 29.99 },
  { id: 2, name: "Sauce Labs Bike Light", price: 9.99 },
  { id: 3, name: "Sauce Labs Bolt T-Shirt", price: 15.99 }
];

app.get('/api/products', (req, res) => res.json(products));
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === "standard_user" && password === "secret_sauce") {
    return res.json({ success: true, token: "demo-token" });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.listen(4000, () => console.log('Backend running on port 4000'));
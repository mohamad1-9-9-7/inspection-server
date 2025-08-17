const url = "https://inspection-server-4nvj.onrender.com/api/reports";

const data = {
  reporter: "mohamad",
  type: "returns",
  payload: {
    reportDate: "2025-08-16",
    items: [
      { productName: "Laptop Dell XPS", qty: 2 },
      { productName: "Mouse Logitech", qty: 5 }
    ]
  }
};

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data)
});

const json = await res.json();
console.log("Response:", json);

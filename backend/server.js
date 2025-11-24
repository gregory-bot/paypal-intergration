import dotenv from "dotenv";
dotenv.config();

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

// Validate environment variables
if (!PAYSTACK_SECRET_KEY) {
  console.error("⚠️ Paystack secret key is missing in .env");
}

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("⚠️ PayPal credentials are missing in .env");
}

// Helper function to get PayPal access token
async function getPayPalAccessToken() {
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`PayPal auth failed: ${data.error_description || 'Unknown error'}`);
    }

    return data.access_token;
  } catch (error) {
    console.error('Error getting PayPal access token:', error);
    throw error;
  }
}

// ========== PAYSTACK ROUTES ========== //

// Payment initialization route
app.post("/api/paystack/pay", async (req, res) => {
  try {
    const { email, amount } = req.body;

    if (!email || !amount) {
      return res.status(400).json({ error: "Email and amount are required" });
    }

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount, // in kobo
        callback_url: "https://remboglow.com/",
      }),
    });

    const data = await response.json();

    if (!data.status) {
      console.error("Paystack init error:", data);
      return res.status(400).json({ error: "Payment initialization failed", details: data });
    }

    res.json(data);
  } catch (err) {
    console.error("Server error initializing payment:", err);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// Payment verification route
app.get("/verify/:reference", async (req, res) => {
  const reference = req.params.reference;

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });

    const data = await response.json();

    if (data?.data?.status === "success") {
      // Payment succeeded, frontend can mark sessionStorage 'paystack_paid'
      return res.json({ data: { status: "success", reference } });
    } else {
      return res.json({ data: { status: "failed", reference } });
    }
  } catch (err) {
    console.error("Paystack verification error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ========== PAYPAL ROUTES ========== //

// Create PayPal order
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { amount, currency = "USD", returnUrl, cancelUrl } = req.body;

    if (!amount || !returnUrl || !cancelUrl) {
      return res.status(400).json({ 
        error: "Amount, returnUrl, and cancelUrl are required" 
      });
    }

    const accessToken = await getPayPalAccessToken();

    const orderData = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: currency,
            value: amount.toString(),
          },
        },
      ],
      application_context: {
        brand_name: "Face Fit",
        landing_page: "BILLING",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify(orderData),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("PayPal create order error:", data);
      return res.status(400).json({ 
        error: "PayPal order creation failed", 
        details: data 
      });
    }

    // Find approval URL
    const approvalLink = data.links.find(link => link.rel === "approve");
    
    if (!approvalLink) {
      throw new Error("No approval URL found in PayPal response");
    }

    res.json({
      orderId: data.id,
      approvalUrl: approvalLink.href,
      status: data.status,
    });

  } catch (error) {
    console.error("PayPal create order error:", error);
    res.status(500).json({ 
      error: "Failed to create PayPal order",
      message: error.message 
    });
  }
});

// Capture PayPal payment
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("PayPal capture error:", data);
      return res.status(400).json({ 
        error: "PayPal capture failed", 
        details: data 
      });
    }

    res.json({
      success: true,
      orderId: data.id,
      status: data.status,
      payer: data.payer,
      purchase_units: data.purchase_units,
    });

  } catch (error) {
    console.error("PayPal capture error:", error);
    res.status(500).json({ 
      error: "Failed to capture PayPal payment",
      message: error.message 
    });
  }
});

// Verify PayPal payment (optional - for frontend to check payment status)
app.get("/api/paypal/verify/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("PayPal verification error:", data);
      return res.status(400).json({ 
        error: "PayPal verification failed", 
        details: data 
      });
    }

    res.json({
      orderId: data.id,
      status: data.status,
      create_time: data.create_time,
      update_time: data.update_time,
      payer: data.payer,
      purchase_units: data.purchase_units,
    });

  } catch (error) {
    console.error("PayPal verification error:", error);
    res.status(500).json({ 
      error: "Failed to verify PayPal payment",
      message: error.message 
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    services: {
      paystack: !!PAYSTACK_SECRET_KEY,
      paypal: !!(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET)
    }
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`PayStack: ${PAYSTACK_SECRET_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`PayPal: ${PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET ? 'Configured' : 'Not configured'}`);
  console.log(`PayPal Mode: ${PAYPAL_BASE_URL.includes('sandbox') ? 'SANDBOX' : 'LIVE'}`);
});
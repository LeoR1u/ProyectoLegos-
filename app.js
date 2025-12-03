// app.js
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import PDFDocument from 'pdfkit';
import db from './db.js';

const app = express();

// =======================================
// CONFIGURACIONES BASE
// =======================================
app.set('view engine', 'ejs');
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// =======================================
// SESIONES
// =======================================
app.use(session({
    secret: process.env.SESSION_SECRET || 'super_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// =======================================
// MIDDLEWARE DEL CARRITO
// =======================================
app.use((req, res, next) => {
    if (!req.session.cart) req.session.cart = [];
    res.locals.user = req.session.user || null;
    res.locals.cartCount = req.session.cart.reduce((acc, i) => acc + i.quantity, 0);
    next();
});

// =======================================
// INICIO / PRODUCTOS
// =======================================
app.get('/', (req, res) => {
    const query = "SELECT product_id, name, price, image FROM products";

    db.query(query, (err, products) => {
        if (err) {
            console.error(err);
            return res.send("Error al cargar productos.");
        }
        res.render('index', { products });
    });
});

// =======================================
// AÑADIR AL CARRITO
// =======================================
app.post('/add-to-cart', (req, res) => {
    const { product_id, name, price, image } = req.body;

    const existing = req.session.cart.find(p => p.product_id == product_id);

    if (existing) {
        existing.quantity++;
    } else {
        req.session.cart.push({
            product_id,
            name,
            price: parseFloat(price),
            image,
            quantity: 1
        });
    }

    res.redirect('/');
});

// =======================================
// VER CARRITO
// =======================================
app.get('/cart', (req, res) => {
    const total = req.session.cart.reduce((a, b) => a + b.price * b.quantity, 0);
    res.render('cart', { cart: req.session.cart, total });
});

// =======================================
// ACTUALIZAR CARRITO (AJAX)
// =======================================
app.post('/update-cart', (req, res) => {
    const { product_id, action } = req.body;

    const item = req.session.cart.find(i => i.product_id == product_id);
    if (!item) return res.json({ success: false });

    if (action === "increase") item.quantity++;
    if (action === "decrease") item.quantity--;
    if (item.quantity <= 0 || action === "remove") {
        req.session.cart = req.session.cart.filter(i => i.product_id != product_id);
    }

    const total = req.session.cart.reduce((a, b) => a + (b.price * b.quantity), 0);
    const count = req.session.cart.reduce((a, b) => a + b.quantity, 0);

    res.json({ success: true, total, count, cart: req.session.cart });
});

// =======================================
// LOGIN / REGISTRO
// =======================================
app.get('/login', (_, res) => res.render('login'));
app.get('/register', (_, res) => res.render('register'));

app.post('/register', (req, res) => {
    const { username, password } = req.body;

    const query = "INSERT INTO users (username, password) VALUES (?, ?)";
    db.query(query, [username, password], err => {
        if (err) {
            console.error(err);
            return res.send("Error al registrar.");
        }
        res.redirect('/login');
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const query = "SELECT * FROM users WHERE username = ? AND password = ?";
    db.query(query, [username, password], (err, results) => {
        if (err) return res.send("Error en login.");

        if (results.length === 0) {
            return res.send("Credenciales incorrectas. <a href='/login'>Intentar</a>");
        }

        const user = results[0];
        req.session.user = user;

        // Cargar carrito pendiente
        const cartQuery = "SELECT cart_data FROM pending_carts WHERE user_id = ?";
        db.query(cartQuery, [user.user_id], (err, rows) => {
            if (!err && rows.length > 0) {
                req.session.cart = JSON.parse(rows[0].cart_data);

                db.query("DELETE FROM pending_carts WHERE user_id = ?", [user.user_id]);
            }

            res.redirect('/');
        });
    });
});

// =======================================
// LOGOUT
// =======================================
app.get('/logout', (req, res) => {

    if (req.session.user && req.session.cart.length > 0) {
        const query = "REPLACE INTO pending_carts (user_id, cart_data) VALUES (?, ?)";
        db.query(query, [req.session.user.user_id, JSON.stringify(req.session.cart)]);
    }

    req.session.destroy(() => res.redirect('/'));
});

// =======================================
// CHECKOUT + TICKET PDF
// =======================================
app.get('/checkout', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.cart.length === 0) return res.redirect('/');

    const total = req.session.cart.reduce((a, b) => a + b.price * b.quantity, 0);
    const items = [...req.session.cart];

    const orderQuery = "INSERT INTO orders (user_id, total) VALUES (?, ?)";

    db.query(orderQuery, [req.session.user.user_id, total], (err, result) => {
        if (err) return res.send("Error generando orden.");

        const orderId = result.insertId;

        const itemsQuery = `
            INSERT INTO order_items (order_id, product_name, quantity, price)
            VALUES ?
        `;

        const values = items.map(i => [orderId, i.name, i.quantity, i.price]);

        db.query(itemsQuery, [values], (err) => {
            if (err) return res.send("Error guardando productos.");

            req.session.cart = [];

            // ========== TICKET PDF ==========
            const doc = new PDFDocument();
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename=ticket_${orderId}.pdf`);
            doc.pipe(res);

            doc.fontSize(20).text("LEGO STORE - TICKET", { align: "center" });
            doc.moveDown();
            doc.fontSize(12).text(`Orden ID: ${orderId}`);
            doc.text(`Cliente: ${req.session.user.username}`);
            doc.text(`Fecha: ${new Date().toLocaleString()}`);
            doc.moveDown();
            doc.text("----------------------------------------");

            items.forEach(i => {
                doc.text(`${i.quantity} x ${i.name} — $${(i.quantity * i.price).toFixed(2)}`);
            });

            doc.text("----------------------------------------");
            doc.fontSize(16).text(`TOTAL: $${total.toFixed(2)}`, { align: "right" });

            doc.end();
        });
    });
});

// =======================================
// HISTORIAL
// =======================================
app.get('/history', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const query = `
        SELECT o.order_id, o.total, o.date,
        GROUP_CONCAT(CONCAT(oi.product_name, ' (', oi.quantity, ')') SEPARATOR ', ') AS items
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        WHERE o.user_id = ?
        GROUP BY o.order_id
        ORDER BY o.date DESC
    `;

    db.query(query, [req.session.user.user_id], (err, orders) => {
        if (err) return res.send("Error cargando historial.");
        res.render('history', { orders });
    });
});

// =======================================
// PUERTO
// =======================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));

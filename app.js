const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const PDFDocument = require('pdfkit');

const app = express();

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: 'lego_secret_key',
    resave: false,
    saveUninitialized: true
}));

app.use((req, res, next) => {
    if (!req.session.cart) req.session.cart = [];
    res.locals.user = req.session.user;
    res.locals.cartCount = req.session.cart.reduce((acc, item) => acc + item.quantity, 0);
    next();
});

app.get('/', (req, res) => {
    db.query('SELECT * FROM products', (err, products) => {
        if (err) throw err;
        res.render('index', { products });
    });
});

app.post('/add-to-cart', (req, res) => {
    const { id, name, price, image } = req.body;
    const existingItem = req.session.cart.find(item => item.id == id);

    if (existingItem) {
        existingItem.quantity++;
    } else {
        req.session.cart.push({
            id, name, price: parseFloat(price), image, quantity: 1
        });
    }
    res.redirect('/');
});

app.get('/cart', (req, res) => {
    const total = req.session.cart.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    res.render('cart', { cart: req.session.cart, total });
});

app.post('/update-cart', (req, res) => {
    const { id, action } = req.body;
    const itemIndex = req.session.cart.findIndex(item => item.id == id);

    if (itemIndex > -1) {
        if (action === 'increase') {
            req.session.cart[itemIndex].quantity++;
        } else if (action === 'decrease') {
            req.session.cart[itemIndex].quantity--;
            if (req.session.cart[itemIndex].quantity <= 0) {
                req.session.cart.splice(itemIndex, 1);
            }
        } else if (action === 'remove') {
            req.session.cart.splice(itemIndex, 1);
        }
    }
    
    // Recalcular total para devolverlo
    const newTotal = req.session.cart.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const newCount = req.session.cart.reduce((acc, item) => acc + item.quantity, 0);
    
    res.json({ success: true, newTotal, newCount, cart: req.session.cart });
});

app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], (err) => {
        if (err) return res.send('Error al registrar');
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err) throw err;

        if (results.length > 0) {
            const user = results[0];
            req.session.user = user;
            
            db.query('SELECT cart_data FROM pending_carts WHERE user_id = ?', [user.id], (err, cartResults) => {
                if (err) console.error("Error al cargar carrito pendiente:", err);

                if (cartResults && cartResults.length > 0) {
                    req.session.cart = JSON.parse(cartResults[0].cart_data);

                    db.query('DELETE FROM pending_carts WHERE user_id = ?', [user.id], (err) => {
                        if (err) console.error("Error al eliminar carrito pendiente:", err);
                    });
                }
                
                res.redirect('/');
            });

        } else {
            res.send('Credenciales incorrectas <a href="/login">Intentar de nuevo</a>');
        }
    });
});

app.get('/logout', (req, res) => {
    if (req.session.user && req.session.cart.length > 0) {
        const userId = req.session.user.id;
        const cartData = JSON.stringify(req.session.cart);

        const saveQuery = 'REPLACE INTO pending_carts (user_id, cart_data) VALUES (?, ?)';
        
        db.query(saveQuery, [userId, cartData], (err) => {
            if (err) console.error("Error al guardar carrito pendiente:", err);
            
            req.session.destroy(() => {
                res.redirect('/');
            });
        });
    } else {
        req.session.destroy(() => {
            res.redirect('/');
        });
    }
});


app.get('/checkout', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.cart.length === 0) return res.redirect('/');

    const userId = req.session.user.id;
    const total = req.session.cart.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const cartCopy = [...req.session.cart];

    db.query('INSERT INTO orders (user_id, total) VALUES (?, ?)', [userId, total], (err, result) => {
        if (err) throw err;
        const orderId = result.insertId;

        const orderItems = cartCopy.map(item => [orderId, item.name, item.quantity, item.price]);
        db.query('INSERT INTO order_items (order_id, product_name, quantity, price) VALUES ?', [orderItems], (err) => {
            if (err) throw err;

            req.session.cart = [];

            const doc = new PDFDocument();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=ticket_${orderId}.pdf`);

            doc.pipe(res);

            doc.fontSize(20).text('LEGO STORE - TICKET DE COMPRA', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Orden ID: ${orderId}`);
            doc.text(`Cliente: ${req.session.user.username}`);
            doc.text(`Fecha: ${new Date().toLocaleString()}`);
            doc.moveDown();
            doc.text('------------------------------------------------');
            
            cartCopy.forEach(item => {
                doc.text(`${item.quantity} x ${item.name} - $${(item.price * item.quantity).toFixed(2)}`);
            });
            
            doc.text('------------------------------------------------');
            doc.moveDown();
            doc.fontSize(16).text(`TOTAL: $${total.toFixed(2)}`, { align: 'right' });
            
            doc.end();
        });
    });
});

app.get('/history', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const query = `
        SELECT o.id, o.total, o.date, 
        GROUP_CONCAT(oi.product_name, ' (', oi.quantity, ')') as items 
        FROM orders o 
        JOIN order_items oi ON o.id = oi.order_id 
        WHERE o.user_id = ? 
        GROUP BY o.id, o.total, o.date
        ORDER BY o.date DESC`;

    db.query(query, [req.session.user.id], (err, orders) => {
        if (err) throw err;
        res.render('history', { orders });
    });
});

app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});
// ============================================
// BOOM ZAPAS - Servidor Backend
// Node.js + Express + Supabase + Mercado Pago
// ============================================

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();

// CORS - acepta cualquier origen (tienda + admin + local)
app.use(cors());
app.use(express.json());

// ── Supabase ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Mercado Pago ──
let mpClient = null;
if (process.env.MP_ACCESS_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => res.json({ status: 'ok', app: 'Boom Zapas API' }));

// ============================================
// PRODUCTOS Y STOCK
// ============================================

app.get('/api/productos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('*, stock(*)')
      .eq('activo', true)
      .order('id');
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stock/:productoId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stock')
      .select('talle, cantidad')
      .eq('producto_id', req.params.productoId)
      .order('talle');
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// PEDIDOS
// ============================================

app.post('/api/pedido', async (req, res) => {
  try {
    const { cliente, items, metodo_pago, notas } = req.body;

    // Verificar stock
    for (const item of items) {
      const { data: stockData } = await supabase
        .from('stock')
        .select('cantidad')
        .eq('producto_id', item.producto_id)
        .eq('talle', item.talle)
        .single();
      if (!stockData || stockData.cantidad < item.cantidad) {
        return res.status(400).json({ error: `Sin stock: producto ${item.producto_id} talle ${item.talle}` });
      }
    }

    // Crear/encontrar cliente
    let clienteId = null;
    if (cliente && (cliente.email || cliente.telefono)) {
      let query = supabase.from('clientes').select('id');
      if (cliente.email) query = query.eq('email', cliente.email);
      else query = query.eq('telefono', cliente.telefono);
      
      const { data: existing } = await query.single();
      if (existing) {
        clienteId = existing.id;
      } else {
        const { data: nuevo } = await supabase.from('clientes').insert(cliente).select('id').single();
        clienteId = nuevo?.id;
      }
    }

    const total = items.reduce((s, i) => s + i.precio_unit * i.cantidad, 0);

    const { data: pedido, error } = await supabase
      .from('pedidos')
      .insert({ cliente_id: clienteId, total, estado: 'pendiente', metodo_pago, notas })
      .select('id')
      .single();

    if (error) throw error;

    await supabase.from('pedido_items').insert(
      items.map(i => ({ ...i, pedido_id: pedido.id }))
    );

    res.json({ ok: true, pedido_id: pedido.id, total });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// MERCADO PAGO
// ============================================

app.post('/api/mp/crear-preferencia', async (req, res) => {
  if (!mpClient) return res.status(503).json({ error: 'MP no configurado aún' });
  
  try {
    const { items, pedido_id, cliente } = req.body;
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: items.map(i => ({
          id:          String(i.producto_id),
          title:       `${i.nombre} talle ${i.talle}`,
          quantity:    i.cantidad,
          unit_price:  i.precio_unit,
          currency_id: 'ARS'
        })),
        payer: { name: cliente?.nombre || '', email: cliente?.email || 'comprador@boomzapas.com' },
        back_urls: {
          success: `https://boomzapas.netlify.app?pago=ok&pedido=${pedido_id}`,
          failure: `https://boomzapas.netlify.app?pago=error&pedido=${pedido_id}`,
          pending: `https://boomzapas.netlify.app?pago=pendiente&pedido=${pedido_id}`
        },
        auto_return:        'approved',
        notification_url:   `${process.env.SERVER_URL}/api/mp/webhook`,
        external_reference: String(pedido_id),
        statement_descriptor: 'BOOM ZAPAS'
      }
    });
    res.json({ init_point: result.init_point, preference_id: result.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mp/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);

    const payment = new Payment(mpClient);
    const paymentData = await payment.get({ id: data.id });
    if (paymentData.status !== 'approved') return res.sendStatus(200);

    const pedidoId = parseInt(paymentData.external_reference);

    await supabase.from('pedidos').update({
      estado: 'pagado',
      mp_payment_id: String(data.id)
    }).eq('id', pedidoId);

    const { data: items } = await supabase
      .from('pedido_items').select('*').eq('pedido_id', pedidoId);

    for (const item of items) {
      await supabase.rpc('descontar_stock', {
        p_producto_id: item.producto_id,
        p_talle:       item.talle,
        p_cantidad:    item.cantidad
      });
    }

    console.log(`✅ Pago confirmado - Pedido #${pedidoId}`);
    res.sendStatus(200);
  } catch(e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

// ============================================
// ADMIN - rutas protegidas
// ============================================

const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
};

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [pedidosRes, stockBajoRes] = await Promise.all([
      supabase.from('pedidos').select('estado, total'),
      supabase.from('stock').select('*, productos(nombre)').lt('cantidad', 3)
    ]);

    res.json({
      total_pedidos:   pedidosRes.data?.length || 0,
      pedidos_pagados: pedidosRes.data?.filter(p => p.estado === 'pagado').length || 0,
      ingresos_total:  pedidosRes.data?.filter(p => p.estado === 'pagado')
                         .reduce((s, p) => s + Number(p.total), 0) || 0,
      stock_bajo:      stockBajoRes.data || []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/pedidos', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vista_pedidos').select('*').limit(100);
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/pedido/:id', adminAuth, async (req, res) => {
  try {
    const { estado } = req.body;
    const { data, error } = await supabase
      .from('pedidos').update({ estado }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/stock', adminAuth, async (req, res) => {
  try {
    const { producto_id, talle, cantidad } = req.body;
    const { data, error } = await supabase
      .from('stock')
      .upsert({ producto_id, talle, cantidad })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Boom Zapas API corriendo en puerto ${PORT}`));

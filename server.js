// Boom Zapas API v3
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
};

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Boom Zapas API v3' }));

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [pedidosRes, stockBajoRes] = await Promise.all([
      supabase.from('pedidos').select('estado, total'),
      supabase.from('stock').select('*, productos(nombre)').lt('cantidad', 3)
    ]);
    res.json({
      total_pedidos: pedidosRes.data?.length || 0,
      pedidos_pagados: pedidosRes.data?.filter(p => p.estado === 'pagado').length || 0,
      ingresos_total: pedidosRes.data?.filter(p => p.estado === 'pagado').reduce((s, p) => s + Number(p.total), 0) || 0,
      stock_bajo: stockBajoRes.data || []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/pedidos', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('vista_pedidos').select('*').limit(100);
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/pedido/:id', adminAuth, async (req, res) => {
  try {
    const { estado } = req.body;
    const { data, error } = await supabase.from('pedidos').update({ estado }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/stock', adminAuth, async (req, res) => {
  try {
    const { producto_id, talle, cantidad } = req.body;
    const { data, error } = await supabase.from('stock').upsert({ producto_id, talle, cantidad }).select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/productos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('productos').select('*, stock(*)').eq('activo', true).order('id');
    if (error) throw error;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pedido', async (req, res) => {
  try {
    const { cliente, items, metodo_pago, notas } = req.body;
    let clienteId = null;
    if (cliente && (cliente.email || cliente.telefono)) {
      const { data: nuevo } = await supabase.from('clientes').insert(cliente).select('id').single();
      clienteId = nuevo?.id;
    }
    const total = items.reduce((s, i) => s + i.precio_unit * i.cantidad, 0);
    const { data: pedido, error } = await supabase.from('pedidos').insert({ cliente_id: clienteId, total, estado: 'pendiente', metodo_pago, notas }).select('id').single();
    if (error) throw error;
    await supabase.from('pedido_items').insert(items.map(i => ({ ...i, pedido_id: pedido.id })));
    res.json({ ok: true, pedido_id: pedido.id, total });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Boom Zapas API corriendo en puerto ${PORT}`));

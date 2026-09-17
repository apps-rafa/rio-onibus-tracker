module.exports = (req, res) => {
  res.status(200).json({ ok: true, agora: new Date().toISOString() });
};

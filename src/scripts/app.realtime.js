// ── Realtime preview updates ──────────────────────────────────────
document.getElementById('ycTitle').addEventListener('input', updateYcPreview);
document.getElementById('ycMsg').addEventListener('input', updateYcPreview);
document.getElementById('brbTitle').addEventListener('input', ()=>{ document.getElementById('pvBrbTitle').textContent=document.getElementById('brbTitle').value||'VUELVO ENSEGUIDA'; });
document.getElementById('brbMsg').addEventListener('input', ()=>{ document.getElementById('pvBrbMsg').textContent=document.getElementById('brbMsg').value||'Ya vuelvo...'; });
document.getElementById('finTitle').addEventListener('input', ()=>{ document.getElementById('pvFinTitle').textContent=document.getElementById('finTitle').value||'FIN DEL STREAM'; });
document.getElementById('finMsg').addEventListener('input', ()=>{ document.getElementById('pvFinMsg').textContent=document.getElementById('finMsg').value||'¡Gracias por quedarte!'; });


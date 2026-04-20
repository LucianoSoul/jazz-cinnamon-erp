# Jazz Cinnamon ERP

## Seguranca do banco

- O painel usa login real do Firebase Auth e nao usa mais sessao anonima.
- As regras do Firestore ficam versionadas em `firestore.rules`.
- As regras do Cloud Storage ficam versionadas em `storage.rules` e liberam leitura publica somente para os assets usados pelo site.
- A colecao sensivel `pedidos` permite leitura/listagem completa apenas para o email admin configurado nas regras.
- O formulario publico cria novos pedidos com campos limitados e consulta conflitos pela colecao sanitizada `disponibilidade_publica`.
- Novos links de contrato e NF usam tokens em `links_publicos` com validade de 30 dias.

Se o email admin mudar, atualize:

- `firestore.rules`
- `PUBLIC/index.html`
- `PUBLIC/painel_erp.html`

## Notificacao de novo pedido no PWA

A Cloud Function `notificarNovoOrcamento` envia Web Push sempre que um novo documento e criado em `pedidos` com status `PRE_RESERVA`.

Configure `functions/.env` a partir de `functions/.env.example` antes do deploy:

```env
VAPID_PUBLIC_KEY=sua-chave-publica-web-push
VAPID_SUBJECT=mailto:luciano.cinnamon@gmail.com
PANEL_URL=https://jazz-cinnamon-erp.web.app/painel_erp.html
```

A chave privada Web Push fica no Secret Manager como `VAPID_PRIVATE_KEY`.

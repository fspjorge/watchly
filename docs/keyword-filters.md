# Filtro de alterações por keywords

Cada monitorização pode ter até 10 keywords, uma por linha, com até 80 caracteres por termo. O campo vazio mantém o comportamento anterior: qualquer alteração é considerada relevante. As correspondências usam texto normalizado Unicode e não distinguem maiúsculas de minúsculas. Basta uma keyword corresponder.

O filtro é aplicado às linhas adicionadas e removidas do diff. Texto inalterado não conta como correspondência. Por isso, se uma keyword estiver apenas numa linha inalterada e mudar uma linha próxima, essa alteração é filtrada. Quando há correspondência, o estado é `changed`, o diff mostra apenas os blocos que contêm keywords e as notificações existentes podem ser criadas normalmente.

Alterações sem correspondência são guardadas como novos snapshots e ficam com o estado `filtered`. Isto actualiza a base de comparação sem gerar uma notificação nem acumular alterações irrelevantes para uma execução futura. A vista de diferenças também filtra os blocos não correspondentes. As keywords são opcionais na criação e podem ser editadas ou removidas sem alterar a frequência de verificação.

A migration `0008_monitor_keywords.sql` adiciona a configuração com valor vazio para todos os monitores existentes, preservando o seu comportamento actual.

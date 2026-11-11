# FocusFlow

FocusFlow é um aplicativo desktop para Windows que acompanha sua rotina diária de trabalho e estudo. Ele usa Electron, React, TypeScript e Vite. O aplicativo funciona localmente, sem conta, backend, telemetria ou conexão com a internet durante o uso.

## Recursos

- Widget flutuante sem moldura, arrastável, com timer baseado no relógio local, modo compacto, opção de transparência e posição lembrada entre monitores.
- Janela principal com atividade atual, contagem regressiva, progresso do dia e linha do tempo completa.
- Agendas separadas e editáveis: segunda a sexta (encerramento às 18h) e sábado (08:00 às 12:00, sem almoço nem tarde). O domingo é descanso; o sábado vem ativado por padrão e pode ser desativado em Configurações.
- Monitor de hardware ao vivo (CPU do sistema, RAM física usada/total, GPU, atividade e capacidade de disco), com `N/D` quando o Windows não fornece o dado. Pode ser desativado.
- Transições automáticas, notificação nativa do Windows, toque opcional, anúncio de voz em português e aviso opcional cinco minutos antes.
- Pausa e retomada, sessões manuais, extensão de atividade, pular atividade, modo sem distrações e retorno à agenda automática.
- Editor local da agenda com nome, horário, cor e ícone. Salva automaticamente e bloqueia horários inválidos ou sobrepostos.
- Bandeja do sistema (clique, duplo clique e menu), início opcional com o Windows minimizado na bandeja e preferências de aparência e notificações.
- Recuperação limitada de janelas travadas, logs locais e status do sistema em Configurações.
- Dados salvos no arquivo `focusflow.json` (formato versionado, gravação atômica, backup e migração automática de versões anteriores) na pasta de dados do usuário do Windows (`%APPDATA%FocusFlow`).

## Desenvolvimento

Instale Node.js 20.19+ (ou 22.12+) e npm. Na pasta deste projeto, execute:

```powershell
npm install
npm run dev
```

O comando abre o painel e o widget. Fechar o painel o envia para a bandeja; use o menu da bandeja para reabri-lo ou sair do aplicativo.

## Testes e validação

```powershell
npm run typecheck
npm test
npm run build
```

Os testes usam datas determinísticas como relógio falso e cobrem: sábado às 07:59, 08:00, 11:59 e 12:00; domingo como descanso; preservação da agenda de segunda a sexta; migração de um `focusflow.json` existente; reinício e retomada após suspensão sem notificações repetidas; falhas do provedor de hardware e GPU indisponível; fechar para a bandeja, saída intencional e recuperação de falhas; ícone da bandeja e posição de janelas entre monitores.

Verificação em um aplicativo real (bandeja, janelas, monitor de hardware, início oculto, registro de inicialização e recuperação de falha do renderer):

```powershell
npm run build
node scripts/smoke.mjs                  # versão de desenvolvimento
node scripts/smoke.mjs release-winwin-unpackedFocusFlow.exe --hidden --startup --crash
```

## Gerar o instalador do Windows

Em uma máquina Windows com Node.js e conexão à internet para baixar as dependências, execute:

```powershell
npm install
npm run package:win
```

O instalador NSIS será criado em `release-win/FocusFlow-Setup-1.1.1.exe`. Para a versão portátil, use `npm run package:portable` (`release-win/FocusFlow-Portable-1.1.1.exe`) ou `npm run package:all` para ambos. O instalador oferece escolha do diretório, atalho na área de trabalho e no menu Iniciar.

## Instalação e uso

1. Execute `release-win/FocusFlow-Setup-1.1.1.exe` e escolha o local de instalação.
2. Abra o FocusFlow pelo menu Iniciar ou pelo atalho da área de trabalho.
3. O painel e o widget flutuante são abertos. Arraste o widget para o canto desejado; a posição é guardada.
4. Use os controles do widget para pausar, abrir o painel, trocar para o modo compacto ou manter o widget acima de outras janelas.
5. Feche o painel para deixá-lo na bandeja. Selecione **Sair do FocusFlow** no menu da bandeja para encerrar completamente.
6. Edite as rotinas em **Agenda** (abas *Segunda a sexta* e *Sábado*) e configure notificações, dias de trabalho, monitor de hardware e aparência em **Configurações**.

## Estrutura

- `electron/`: processo principal, bandeja, janelas, armazenamento atômico, logs, recuperação, monitor de hardware e preload seguro.
- `src/domain/`: lógica testável da agenda por dia, migração, motor de notificações e controles de sessão.
- `src/ui/`: painel, editor, configurações, widget e tema.
- `release-win/`: artefatos criados pelo empacotador (ignorados pelo Git).

## Observações

- As notificações nativas dependem de o Windows permitir notificações para o aplicativo. Os anúncios por voz usam as vozes instaladas no Windows.
- Ao voltar de suspensão, o timer é recalculado pelo horário atual; o aplicativo não tenta reproduzir avisos de transições passadas.
- A opção de início automático grava a preferência de inicialização do Windows (abre minimizado na bandeja) e pode ser controlada em Configurações; o Windows também pode desativá-la em Configurações › Aplicativos › Inicialização, e o status mostra isso. O desinstalador remove o registro.
- O monitor de hardware lê contadores de desempenho do Windows por um único processo PowerShell oculto, apenas enquanto uma janela está visível. Sem rede, sem telemetria. GPU/disco indisponíveis aparecem como `N/D`.
- Logs ficam em `%APPDATA%FocusFlowlogs`. Se o arquivo de dados estiver corrompido, ele é preservado como `focusflow.corrupt.<hora>.json` e o último backup válido é usado.
- Não há serviço nem tarefa agendada de reinício: a recuperação é feita pelo próprio aplicativo, com limites (veja o CHANGELOG e `docs/crash-recovery.md`).

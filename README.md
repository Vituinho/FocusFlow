# FocusFlow

FocusFlow é um aplicativo desktop para Windows que acompanha sua rotina diária de trabalho e estudo. Ele usa Electron, React, TypeScript e Vite. O aplicativo funciona localmente, sem conta, backend, telemetria ou conexão com a internet durante o uso.

## Recursos

- Widget flutuante sem moldura, arrastável, com timer baseado no relógio local, modo compacto, opção de transparência e posição lembrada entre monitores.
- Janela principal com atividade atual, contagem regressiva, progresso do dia e linha do tempo completa.
- Agenda padrão de segunda a sexta, descanso nos dias sem expediente e encerramento às 18h.
- Transições automáticas, notificação nativa do Windows, toque opcional, anúncio de voz em português e aviso opcional cinco minutos antes.
- Pausa e retomada, sessões manuais, extensão de atividade, pular atividade, modo sem distrações e retorno à agenda automática.
- Editor local da agenda com nome, horário, cor e ícone. Salva automaticamente e bloqueia horários inválidos ou sobrepostos.
- Bandeja do sistema, início opcional com o Windows e preferências de aparência e notificações.
- Dados salvos no arquivo `focusflow.json` da pasta de dados do usuário do Windows.

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

Os testes usam datas determinísticas como relógio falso e cobrem seleção por horário local, limites de atividade, almoço e café, fins de semana, progresso, validação de agenda, pausa/retomada entre blocos e supressão de notificações repetidas.

## Gerar o instalador do Windows

Em uma máquina Windows com Node.js e conexão à internet para baixar as dependências, execute:

```powershell
npm install
npm run package:win
```

O instalador NSIS será criado em `release-win/FocusFlow-Setup-1.0.0.exe`. Para uma versão portátil, use `npm run package:portable`. O instalador oferece escolha do diretório, atalho na área de trabalho e no menu Iniciar.

## Instalação e uso

1. Execute `release-win/FocusFlow-Setup-1.0.0.exe` e escolha o local de instalação.
2. Abra o FocusFlow pelo menu Iniciar ou pelo atalho da área de trabalho.
3. O painel e o widget flutuante são abertos. Arraste o widget para o canto desejado; a posição é guardada.
4. Use os controles do widget para pausar, abrir o painel, trocar para o modo compacto ou manter o widget acima de outras janelas.
5. Feche o painel para deixá-lo na bandeja. Selecione **Sair do FocusFlow** no menu da bandeja para encerrar completamente.
6. Edite a rotina em **Agenda** e configure notificações, dias de trabalho e aparência em **Configurações**.

## Estrutura

- `electron/`: processo principal, bandeja, janelas, armazenamento local, notificações e preload seguro.
- `src/domain/`: lógica testável da agenda e dos controles de sessão.
- `src/ui/`: painel, editor, configurações, widget e tema.
- `release-win/`: artefatos criados pelo empacotador (ignorados pelo Git).

## Observações

- As notificações nativas dependem de o Windows permitir notificações para o aplicativo. Os anúncios por voz usam as vozes instaladas no Windows.
- Ao voltar de suspensão, o timer é recalculado pelo horário atual; o aplicativo não tenta reproduzir avisos de transições passadas.
- A opção de início automático grava a preferência de inicialização do Windows e pode ser controlada novamente em Configurações.

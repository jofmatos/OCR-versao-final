# Lume OCR

Leitor de PDF e conversor para **DOCX editável** ou **TXT**, com OCR em português, inglês e espanhol. Interface em português, utilizável no navegador do computador ou celular. Na versão estática, o seu próprio computador faz o processamento. Há também uma alternativa com servidor Python. Nenhuma exige chave de API nem envia documentos para um serviço de IA.

## Versão que processa no seu próprio navegador

### OCR de documentos com WebGPU

No menu **Motor de leitura**, escolha a opção **documentos (WebGPU)** e clique em **Instalar** no painel do modelo. O nome do modelo selecionado pelo teste aparece na interface. O site informa o tamanho do download, mostra progresso, permite cancelar e reutiliza os arquivos guardados pelo navegador. O processamento das páginas continua no aparelho; os pedidos ao Hugging Face baixam apenas arquivos públicos do modelo. Recomenda-se Chrome atualizado, aceleração gráfica ativada e um Mac com pelo menos 8 GB de memória. iPhone/iPad precisam de WebGPU e memória suficiente; não foram validados em aparelhos reais.

São avaliados **GLM-OCR** e **LightOnOCR-2-1B**, especializados em OCR de documentos, usando exportações ONNX quantizadas em 4 bits. A CI testa os candidatos completos e escolhe entre os aprovados usando a similaridade do texto em português; em diferenças menores que 0,005 na amostra sintética, prefere LightOnOCR, que lista português explicitamente entre os idiomas suportados. Os embeddings quantizados usam WebGPU; visão e decodificação usam WASM na CPU para evitar grandes buffers de GPU e travamentos encontrados na GPU de software dos testes. Um worker separado mantém a interface utilizável. A geração é determinística e limitada; repetições interrompem a leitura com aviso de texto incompleto. Não há correção generativa posterior nem uma porcentagem de confiança inventada. Revise o resultado: esses modelos também podem inserir ou omitir texto.

Antes de publicar, `scripts/prepare_neural_model.py` confirma os três componentes ONNX, registra tamanhos e fixa a revisão imutável de cada candidato. `scripts/benchmark_neural_models.py` executa `scripts/smoke_neural_browser.py` com os pesos reais em Chromium/WebGPU, verifica português, acentos, números, TXT, ausência de upload e recarga offline dos pesos. Quando possível, registra PaddleOCR/Tesseract na mesma amostra como referência. A publicação depende de pelo menos um candidato passar; o resultado fica no resumo da CI e em `static/ocr-comparison.json` do site. A amostra sintética não estabelece um ranking universal nem a precisão em PDFs do usuário. `scripts/smoke_browser.py` usa respostas controladas para testar instalação, cancelamento, erros, edição e DOCX; esses testes de protocolo não medem precisão do modelo. A decisão e suas fontes estão em [docs de seleção do modelo](research/ocr-model-selection.md).

### Apple Vision: outro extrator para macOS

No menu **Motor de leitura**, escolha **Apple Vision · OCR nativo do Mac**. Baixe o **Lume OCR Mac**, extraia o ZIP e abra o aplicativo. Ele aparece na barra de menus e usa o reconhecimento de texto do macOS, com nível de precisão alto e sem correção de palavras por dicionário. Não usa um modelo generativo nem precisa de Python, Terminal ou um download separado de pesos de OCR. Requer macOS 13 ou posterior; o aplicativo é universal, para Intel e Apple Silicon.

Volte ao site e clique em **Conectar ao Mac**. No Chrome, permita acesso à rede local quando solicitado. As imagens de cada página seguem apenas para `127.0.0.1:17861`; o texto volta ao navegador, onde permanecem a edição, o salvamento, DOCX e TXT. O auxiliar não grava PDFs ou imagens em disco nem envia documentos à nuvem. Deixe-o aberto durante a extração; para fechar, use **Lume OCR → Encerrar OCR local** na barra de menus. A primeira abertura pode exigir **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**, pois a compilação tem assinatura ad hoc e ainda não possui notarização da Apple.

O workflow compila o aplicativo em um runner macOS, testa OCR real em uma imagem com português e números e exercita CORS, a API local, entradas inválidas e origens recusadas. Apenas depois desse teste o ZIP é incorporado ao site. Os testes de navegador executados em Linux verificam o protocolo com respostas controladas; não validam o reconhecimento do Apple Vision. A qualidade em documentos reais do usuário ainda precisa ser comparada.

Para compilar e verificar no Mac com as ferramentas de desenvolvimento instaladas:

```bash
bash scripts/build-mac-vision.sh
python3 scripts/smoke_mac_vision.py --executable ".cache/mac-build/Lume OCR Mac.app/Contents/MacOS/LumeOCRMac"
```

O código do auxiliar está em `native/mac-vision/main.swift`. A API escuta somente no loopback e aceita como origem do navegador `https://jofmatos.github.io` e os endereços locais de desenvolvimento declarados no código. Não troque o domínio de publicação sem ajustar essa lista.

### Motores que rodam inteiramente no navegador

A versão estática funciona em um site HTTPS, inclusive no GitHub Pages. **Seu computador executa o PDF e o OCR: nenhum PDF ou texto é enviado ao servidor.** Ela usa PDF.js, Tesseract.js/WebAssembly e os modelos oficiais `best_int`, da família best, quantizados para esse motor. Os modelos de ponto flutuante da versão Python não são compatíveis com a compilação WebAssembly utilizada. Não exige Python, Homebrew, chave de API nem um servidor de processamento no computador do usuário.

O botão **Instalar PaddleOCR** prepara **PaddleOCR v5 mobile com reconhecimento latino**, para português, inglês e espanhol. Baixa cerca de 13 MB de modelos, além de aproximadamente 35 MB do motor, verifica SHA-256 e guarda os arquivos no navegador. Depois de concluir, o motor avançado é selecionado automaticamente e lembrado nas próximas aberturas. O menu **Motor de leitura** permite voltar ao Tesseract. Se o download falhar, o motor atual continua disponível; não há troca silenciosa durante uma conversão.

**Validação pendente do PaddleOCR:** este ambiente de desenvolvimento bloqueou os servidores dos pesos ONNX. O build e o tratamento de falhas são verificáveis, mas o reconhecimento com os modelos v5 escolhidos ainda precisa ser validado antes de afirmar ganho de qualidade. A instalação depende de acesso aos domínios dos modelos. Não foram testados documentos reais do usuário.

O adaptador remove o marcador vazio de CTC do início do dicionário redistribuído antes de entregá-lo ao SDK, que já reserva essa classe. Os testes em `tests/browser/paddle-dictionary.test.mjs` verificam a equivalência com o dicionário oficial e exercitam o decodificador do SDK com acentos e números. Eles reproduzem o deslocamento de caracteres da integração anterior; não substituem um teste de OCR com imagens reais. A amostra em `tests/fixtures/paddle-v5-latin-dict.txt` vem da revisão e do hash do distribuidor descritos abaixo, sob Apache-2.0.

Para o motor básico, escolha **Preparar OCR básico** ou comece a extrair um PDF escaneado. Na primeira vez, os modelos de português e inglês são baixados (cerca de 4,3 MB, mais o motor). Nas próximas vezes, o navegador reutiliza os modelos guardados. Espanhol é baixado se selecionado. Mantenha a página aberta durante a conversão. O limite de pixels é reduzido em dispositivos com pouca memória; a velocidade depende do seu computador.

No Safari recente do Mac, use **Arquivo → Adicionar ao Dock** para abrir como um aplicativo. No Chrome, use a opção de instalar na barra de endereço ou o botão da interface quando disponível. Após preparar os modelos e carregar o site uma vez, a reabertura e o OCR no idioma já preparado funcionam offline. Recursos de PDF ainda não usados (por exemplo fontes especiais) podem precisar de conexão na primeira vez. Os documentos e edições são guardados apenas no armazenamento local do navegador, recuperados após recarga e removidos por você ou após 24 horas na próxima abertura. Limpar os dados do site também remove os modelos e documentos.

Para construir/hospedar essa versão:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
# Necessário para habilitar o motor de documentos; baixa somente os metadados públicos:
python3 scripts/prepare_neural_model.py
npm run build
# A pasta docs/ contém o site, os motores e os modelos básicos. Para testar localmente:
npm run serve
```

O build precisa de Node.js 22+. Bibliotecas e modelos têm versões fixadas e integridade verificada pelo `npm ci`. Quem usa o site precisa somente de um navegador recente. Sirva `docs/` por HTTP/HTTPS; abrir o `index.html` diretamente pelo Finder não funciona, porque navegadores restringem workers e módulos em arquivos locais. A instalação pelo navegador fornece a abertura como aplicativo sem essa limitação.

O workflow `.github/workflows/pages.yml` constrói e publica `docs/`. No GitHub, habilite **Settings → Pages → Source: GitHub Actions**; depois execute **Actions → Publicar Lume OCR → Run workflow**, ou envie um commit para `main`. A URL deve ser confirmada na saída do deploy. Bibliotecas, workers e modelos Tesseract são servidos pelo próprio site. Os pesos PaddleOCR são baixados, somente na instalação, de `media.githubusercontent.com` e `raw.githubusercontent.com`, do repositório `PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models` na revisão `384182c7187c12d4ea181ae3b97c8b7e12089d9d`; cada arquivo é verificado pelo SHA-256 fixado em `browser/paddle-worker.js`. Os modelos e o dicionário são redistribuídos sob Apache-2.0. Nenhum PDF ou texto é incluído nesses pedidos. O SDK oficial `@paddleocr/paddleocr-js` e ONNX Runtime Web são fixados no lockfile; a execução usa um worker separado e WASM com uma thread, compatível com hospedagem sem headers COOP/COEP. O adaptador usa `cv.Mat`, suportado pelo SDK, a partir do OpenCV da instância fixada.

Para testar essa versão com OCR real, downloads, edições, recarga, celular, funcionamento offline e ausência de uploads:

```bash
# Com npm run serve em outro terminal e as dependências de desenvolvimento instaladas:
.venv/bin/python scripts/smoke_browser.py --base-url http://127.0.0.1:8080 --browser-mode
```

As instruções abaixo se referem à versão alternativa com servidor Python.

## O que funciona

- Upload por seleção ou arrastar e soltar; leitura com prévia e navegação por página.
- Extração direta de texto de PDFs digitais e OCR automático para páginas escaneadas; modo de OCR forçado para camadas de texto ruins.
- Tesseract 5 com modelos oficiais **tessdata_best**, reconhecimento LSTM, correção de orientação e tratamento de contraste/nitidez.
- Qualidade alta (até 350 DPI) ou padrão (até 250 DPI), limitada a 20 megapixels por página para controlar memória.
- Conversão de todas as páginas ou intervalos como `1-3, 5`; acompanhamento de progresso.
- Revisão e edição por página, indicação de confiança do OCR e download de DOCX/TXT com o texto corrigido.
- Armazenamento temporário, remoção pelo usuário e expiração automática após 24 horas sem conversão/edição.

Os arquivos podem ter até **50 MB e 200 páginas**. A qualidade do original influencia a precisão: revise nomes, números e acentos. A confiança é uma estimativa do Tesseract, não uma garantia de correção. O DOCX conserva texto, parágrafos e separações de páginas; não reproduz exatamente tabelas, imagens, fórmulas ou a diagramação original. Manuscritos não são a especialidade deste motor. PDFs protegidos por senha precisam ser desbloqueados antes do envio.

## Executar no computador

Requisitos: Python 3.12+, Tesseract 5 e cerca de 500 MB livres. Linux/macOS podem usar os scripts abaixo; no Windows, use Docker Desktop ou WSL2.

```bash
# Debian/Ubuntu, apenas se essas ferramentas não estiverem instaladas:
sudo apt-get update
sudo apt-get install -y python3-venv tesseract-ocr fonts-dejavu-core

# Na pasta deste repositório:
bash scripts/setup.sh
bash scripts/start.sh
```

Abra o navegador na porta local `8000`. `Ctrl+C` encerra o servidor. No macOS, instale os pré-requisitos com `brew install python@3.12 tesseract` e use os mesmos scripts. Se `python3` não for 3.12+, ajuste a instalação do Python antes do setup.

O primeiro setup instala os pacotes fixados em `requirements.txt` e baixa os modelos de `raw.githubusercontent.com`. Cada modelo vem de uma revisão imutável do repositório oficial e é verificado com SHA-256. As execuções seguintes reutilizam os arquivos verificados. Depois da instalação, a conversão funciona sem internet.

## Docker

```bash
docker compose up --build -d
docker compose logs -f
# Encerrar, preservando os documentos até sua expiração:
docker compose down
```

O container usa usuário sem privilégios e o Compose publica somente a porta local. Os modelos são incluídos na imagem; os documentos ficam no volume `lume-data`.

Para hospedar online, execute a mesma aplicação atrás de um proxy HTTPS com autenticação e limite de upload. Esta versão é para uma pessoa ou equipe de confiança: não inclui contas, cobrança nem isolamento entre usuários autenticados. Os links de documentos são identificadores aleatórios; não compartilhe esses endereços com pessoas que não devem acessar os arquivos. A aplicação não lista documentos globalmente. Configure o proxy para um único processo Uvicorn, corpo máximo de 51 MB e `Host` correspondente ao domínio público. Os trabalhos são processados em segundo plano, com dois OCRs simultâneos e fila limitada.

## Configuração

| Variável | Padrão | Uso |
| --- | --- | --- |
| `VENV_PATH` | `.venv` no repositório | Ambiente Python usado pelos scripts |
| `LUME_HOST` | `127.0.0.1` | Interface de rede do script de inicialização |
| `LUME_PORT` | `8000` | Porta do servidor |
| `LUME_DATA_DIR` | `data/` no repositório | PDFs, transcrições e estados temporários |
| `LUME_RETENTION_HOURS` | `24` | Prazo de retenção após upload, conversão ou edição |
| `TESSDATA_PREFIX` | `.cache/tessdata/` | Diretório dos modelos Tesseract |
| `OMP_THREAD_LIMIT` | `2` | Limite de threads por processo Tesseract |

Não coloque dados temporários nem modelos no Git. Arquivos e resultados ficam no disco do servidor, sem criptografia adicional da aplicação. Use armazenamento protegido para documentos sensíveis. A remoção/expiração exclui os arquivos da aplicação, mas não apaga backups externos. Após reiniciar o servidor, documentos concluídos são recuperados e conversões interrompidas podem ser iniciadas novamente. Um cancelamento aguarda o OCR da página atual terminar (limite de 120 segundos).

## Desenvolvimento e testes

```bash
bash scripts/setup.sh --dev
TESSDATA_PREFIX="$PWD/.cache/tessdata" .venv/bin/python -m pytest
```

Os testes criam PDFs digitais e digitalizados, exercitam o OCR real, verificam acentos, edições e arquivos exportados. Os testes de OCR exigem os modelos instalados; o relatório do pytest distingue qualquer teste pulado. A interface usa HTML, CSS e JavaScript sem dependências de CDN ou etapa de compilação. O esquema da API está disponível em `/openapi.json`.

Para verificar a interface no navegador, com o servidor já iniciado em outro terminal:

```bash
# Se não houver Chromium instalado no sistema:
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/smoke_browser.py
```

Essa verificação faz upload de PDFs sintéticos, extrai e edita o texto, inspeciona os downloads de Word/TXT, testa OCR real e o layout de celular, e remove os documentos ao final. Capturas e downloads de teste ficam em `test-results/` (ignorado pelo Git).

Estrutura: `app/main.py` contém a API e o armazenamento temporário, `app/engine.py` faz leitura/OCR/exportação, `app/static/` contém a interface e `scripts/` contém instalação/inicialização. Instâncias com múltiplos processos/workers não são suportadas; para escalar, substitua a fila e o estado local por serviços compartilhados.

## Componentes

Tesseract e os modelos tessdata_best são disponibilizados sob Apache-2.0. PyMuPDF é oferecido sob AGPL-3.0 ou licença comercial; a distribuição e hospedagem devem respeitar a licença escolhida. As demais dependências mantêm suas próprias licenças. Este repositório não altera as licenças desses componentes.

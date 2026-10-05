# Escolha de OCR para execução no navegador

Data da pesquisa: 5 de outubro de 2026. Objetivo: ler PDFs escaneados, sobretudo em português, no próprio aparelho, mantendo a interface publicada no GitHub Pages. A escolha considera qualidade de leitura de documentos, disponibilidade de uma exportação utilizável, memória, distribuição dos pesos e funcionamento em WebGPU. Não é um ranking universal de precisão.

| Candidato | Evidência e adequação | Decisão |
| --- | --- | --- |
| LightOnOCR-2-1B | Modelo de cerca de 1 bilhão de parâmetros especializado em OCR de documentos; português é explicitamente suportado. ONNX q4 completo confirmado: cerca de 729 MiB. Há exportação ONNX completa, com visão, embeddings e decoder em q4; sua arquitetura é suportada no Transformers.js 4.3.0. | Candidato ao novo motor. A publicação exige inferência real em Chromium/WebGPU, incluindo acentos e números em português. |
| GLM-OCR | Modelo de 0,9 bilhão de parâmetros; ONNX q4 completo confirmado: cerca de 708 MiB. A documentação lista oito idiomas e não inclui português. O projeto anuncia 94,62 no OmniDocBench 1.5 para o pipeline com PP-DocLayout-V3 e reconhecimento. Transformers.js suporta a arquitetura, mas o resultado desse pipeline não equivale ao resultado de um reconhecedor isolado no navegador. | Testado como concorrente; o benchmark completo não prova precisão em português na aplicação. |
| PaddleOCR v5 mobile Latin | Cerca de 13 MB de pesos no aplicativo atual. Tem custo muito menor e um reconhecedor latino específico, mas o usuário relatou resultados ruins em seus documentos. | Mantido como alternativa leve, sem afirmar que o modelo maior sempre o supera. |
| Apple Vision | OCR nativo disponível pelo auxiliar macOS já implementado. O navegador sozinho não expõe o framework nativo. | Mantido para quem aceita instalar o auxiliar no Mac; não atende ao requisito de execução inteiramente dentro de uma página web. |

O pipeline confirma a disponibilidade das exportações completas antes de testar os pesos. Candidatos sem arquivos necessários ou que falham no reconhecimento não são publicados. Entre os aprovados, usa a maior similaridade do texto em português; diferenças de até 0,005 na amostra não são consideradas significativas e favorecem o LightOnOCR-2-1B, que tem suporte explícito a português e foi treinado para documentos ocidentais. O resultado e as falhas ficam em `static/ocr-comparison.json` e no resumo da CI. A precisão final deve ser avaliada com os documentos do usuário; uma imagem sintética confirma integração e caracteres críticos, mas não representa digitalizações históricas, manuscritos, tabelas densas ou páginas danificadas. A quantização q4 também pode alterar resultados em relação aos pesos originais. Não se promete ausência de alucinações.

## Implementação e validação

- O build publicado fixa a revisão exata da exportação ONNX pública selecionada e informa o tamanho dos arquivos usados.
- O operador de embeddings q4 usa WebGPU. Visão e decodificação usam WASM na CPU, evitando grandes buffers de GPU e travamentos encontrados no teste de GPU de software. A execução permanece no navegador.
- Download e inferência ficam em um worker separado. Há progresso, cancelamento, erros de GPU/armazenamento e possibilidade de selecionar os motores anteriores.
- Não há uma segunda IA reescrevendo o OCR. A geração usa `do_sample: false`, limite de tokens e interrupção por repetição, com aviso quando o texto puder estar incompleto.
- Testes de protocolo exercitam a interface e a exportação com respostas controladas. O teste separado `scripts/smoke_neural_browser.py` usa os pesos reais e verifica português, números, TXT, ausência de envio de documentos e inicialização offline. A publicação depende de sua aprovação.
- Não foram testados aparelhos iOS reais nem PDFs do usuário.

## Fontes

1. [Hugging Face Transformers: LightOnOCR](https://github.com/huggingface/transformers/blob/main/docs/source/en/model_doc/lighton_ocr.md) — modelo especializado e arquitetura.
2. [Exportação ONNX de LightOnOCR-2-1B](https://huggingface.co/onnx-community/LightOnOCR-2-1B-ONNX) — pesos usados; existência e arquivos obrigatórios são confirmados no build publicado.
3. [Contrato dos três modelos ONNX](https://github.com/talmago/fast-lightonocr/blob/main/docs/MODEL_CONTRACTS.md) e [script de download](https://github.com/talmago/fast-lightonocr/blob/main/scripts/download_model.py) — evidência independente dos componentes publicados, sem adotar o runtime Rust.
4. [GLM-OCR oficial](https://github.com/zai-org/GLM-OCR) — tamanho, benchmark e composição do pipeline completo.
5. [LightOnOCR-2-1B oficial](https://huggingface.co/lightonai/LightOnOCR-2-1B) e [GLM-OCR oficial](https://huggingface.co/zai-org/GLM-OCR) — idiomas, benchmarks e instruções dos autores.
6. [Transformers.js](https://github.com/huggingface/transformers.js) — execução local por ONNX Runtime e WebGPU; arquiteturas LightOnOCR e GLM-OCR.

O acesso ao Hugging Face foi recusado pela política do ambiente cloud durante a pesquisa local. Os domínios necessários foram salvos no rascunho da configuração. A confirmação dos arquivos e a inferência real são passos de CI independentes, necessários antes de publicar; os testes locais de interface não substituem essa confirmação.

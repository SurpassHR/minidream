// mock pi --list-models 输出（固定表格）
process.stdout.write(`provider  model                                          context  max-out  thinking  images
deepseek  deepseek-v4-flash                              1M       384K     yes       no    
mustore   grok-4.5                                       500K     4.1K     yes       yes   
nvidia    google/gemma-3-4b-it                           131.1K   16.4K    no        yes   
`);

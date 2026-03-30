#!/bin/bash
echo ""
echo "========================================="
echo "  Enviando código para o GitHub..."
echo "========================================="
echo ""

cd "$(dirname "$0")"

git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "========================================="
    echo "  SUCESSO! Código enviado para o GitHub!"
    echo "========================================="
    echo ""
else
    echo ""
    echo "========================================="
    echo "  Se pediu login, tente novamente."
    echo "========================================="
    echo ""
fi

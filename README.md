# Long Image to PDF

Petit outil pour transformer une capture d'ecran tres longue en PDF A4
lisible, page par page.

## Application web

L'application fonctionne directement dans le navigateur. L'image reste sur ton
ordinateur: elle n'est pas envoyee a un serveur.

Ouvre la page GitHub Pages du depot, depose une image, puis clique sur
`Generer le PDF`.

## Version terminal

### Installation

```bash
python3 -m pip install -r requirements.txt
```

### Utilisation

```bash
python3 long_image_to_pdf.py /chemin/vers/capture.png
```

Par defaut, le PDF est cree a cote de l'image d'origine sous la forme :

```text
capture-paginated.pdf
```

Exemple avec le fichier de test :

```bash
python3 long_image_to_pdf.py Capture.png -o Capture-lisible.pdf
```

### Options utiles

```bash
--page-size a4       # a4 ou letter
--margin 0.35       # marge en pouces
--dpi 200           # resolution du PDF genere
--overlap 80        # repete quelques pixels entre deux pages
```

Le script cherche automatiquement des zones horizontales assez blanches pour
eviter de couper en plein milieu d'une ligne de texte.

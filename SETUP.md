# Puesta en marcha (una sola vez, ~15 minutos)

La página guarda todo en Firebase (gratis para este uso), así todos ven los mismos datos al instante.
Se entra con Google y solo pueden usarla los emails que vos autorices.

## 1. Crear el proyecto

1. Entrá a https://console.firebase.google.com con tu cuenta de Google.
2. **Crear un proyecto** → ponele un nombre (ej: `rifa-congreso`). Podés desactivar Google Analytics.

## 2. Activar login y base de datos

1. Menú **Compilación → Authentication → Comenzar → Google** → activar, elegir un email de soporte, guardar.
2. Menú **Compilación → Firestore Database → Crear base de datos** → modo **producción** → ubicación a elección (ej: `southamerica-east1`).

## 3. Conectar la página

1. En la rueda de **Configuración del proyecto → General → Tus apps**, tocá el ícono **`</>` (Web)**, poné un apodo y registrá la app (sin Hosting).
2. Te muestra un bloque `firebaseConfig`. Copiá `apiKey`, `authDomain`, `projectId` y `appId` dentro de `firebase-config.js`.

## 4. Reglas de seguridad (quién puede entrar)

En **Firestore Database → Reglas**, pegá esto y cambiá los emails por los de tu grupo (los de Google de cada uno):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email in [
          'tu-email@gmail.com',
          'companero1@gmail.com',
          'companero2@gmail.com'
        ];
    }
  }
}
```

Tocá **Publicar**. Para sumar o sacar gente, editá la lista y volvé a publicar.

## 5. Publicar la página

La página son archivos estáticos (no necesita servidor propio). Opciones gratis:

- **Netlify Drop** (la más simple): entrá a https://app.netlify.com/drop y arrastrá la carpeta `rifa`. Te da un link.
- **GitHub Pages**: subí la carpeta a un repositorio y activá Pages.

Después, en Firebase: **Authentication → Configuración → Dominios autorizados → Agregar dominio** y agregá el del link que te dieron (ej: `mi-rifa.netlify.app`). Sin esto, el botón de Google no funciona.

## 6. Probar

1. Abrí el link, ingresá con Google.
2. Cargá el precio por número, la meta y agregá un alumno.
3. Pedile a un compañero que entre desde su celular: tiene que ver al alumno al instante.

## Notas

- Las fotos de comprobantes se guardan reducidas dentro de Firestore. El plan gratis alcanza de sobra para unos cientos de ventas.
- Descargá el respaldo (botón al final de la página) de vez en cuando.
- Para probar en tu computadora no sirve abrir `index.html` con doble clic: hace falta un servidor local (por ejemplo `npx serve` dentro de la carpeta).

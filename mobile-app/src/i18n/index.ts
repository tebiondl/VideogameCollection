import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';

const translations = {
    en: {
        welcome: 'Welcome',
        gamesToPlay: 'Games to Play',
        gamesFinished: 'Games Finished',
        settings: 'Settings',
        session: 'Session',
        login: 'Log in',
        username: 'Username',
        password: 'Password',
        logout: 'Logout',
        theme: 'Theme',
        dark: 'Dark',
        light: 'Light',
        language: 'Language',
        ganas: 'Hype',
        nota: 'Rating',
        progress: 'Progress',
        noGames: 'No games found',
        addGame: 'Add Game',
        save: 'Save',
        cancel: 'Cancel',
    },
    es: {
        welcome: 'Bienvenido',
        gamesToPlay: 'Juegos que jugar',
        gamesFinished: 'Juegos terminados',
        settings: 'Opciones',
        session: 'Sesión',
        login: 'Iniciar sesión',
        username: 'Nombre de usuario',
        password: 'Contraseña',
        logout: 'Cerrar sesión',
        theme: 'Tema',
        dark: 'Oscuro',
        light: 'Claro',
        language: 'Idioma',
        ganas: 'Ganas',
        nota: 'Nota',
        progress: 'Progreso',
        noGames: 'No se encontraron juegos',
        addGame: 'Añadir Juego',
        save: 'Guardar',
        cancel: 'Cancelar',
    },
};

const i18n = new I18n(translations);

// Set default locale
i18n.locale = 'en';
i18n.enableFallback = true;

export default i18n;
